import {
  RequestArgument,
  WindowListener,
  WindowRequestEvent,
} from "@tallyho/provider-bridge-shared"
import TahoWindowProvider from "@tallyho/window-provider"

const tahoWindowProvider: TahoProvider = new TahoWindowProvider({
  postMessage: (data: WindowRequestEvent) =>
    window.postMessage(data, window.location.origin),
  addEventListener: (fn: WindowListener) =>
    window.addEventListener("message", fn, false),
  removeEventListener: (fn: WindowListener) =>
    window.removeEventListener("message", fn, false),
  origin: window.location.origin,
})

const tahoRoutedProperties = new Set<string>([
  "request",
  "isConnected",
  "enable",
  "send",
  "sendAsync",
  "on",
  "addListener",
  "removeListener",
  "removeAllListeners",
  "listeners",
  "listenerCount",
] satisfies (keyof TahoWindowProvider)[])

// Used exclusively if Taho is set to replace MetaMask AND MetaMask is not seen
// to be installed. In this case, we drop a MetaMask mock so that sites that
// only support MetaMask allow Taho connections; see the defaultManageProviders
// function below.
const metaMaskMock: WalletProvider = {
  isMetaMask: true,
  emit: (_: string | symbol, ...__: unknown[]) => false,
  on: () => {},
  removeListener: () => {},
  _metamask: {
    isUnlocked: () => {},
    requestBatch: () => {},
  },
  _state: {
    accounts: null,
    isConnected: false,
    isUnlocked: false,
    initialized: false,
    isPermanentlyDisconnected: false,
  },
}

// When doing development logging, used to associate timer logs with the final
// execution result.
let globalLoggingIndex = 0
/**
 * This function reflects the given prop off of the given reflectedObject. If
 * the prop is a function, it ensures that the underlying function is invoked
 * with the original `this` pointer. Finally, if the file was compiled in
 * development mode, it also inserts intercepting logging for introspection.
 */
function reflectRedirectAndDevLog(
  marker: string,
  reflectedObject: object,
  prop: string | symbol,
) {
  const reflected = Reflect.get(reflectedObject, prop, reflectedObject)

  if (process.env.NODE_ENV === "development") {
    if (typeof reflected === "function") {
      return (...args: unknown[]) => {
        const safeSerialize = (object: unknown) => {
          if (object instanceof Error) {
            return `${object.name}[${object.message}]${
              object.stack ? `: \n${object.stack}` : ""
            }`
          }

          try {
            return JSON.stringify(object)
          } catch (err) {
            return `${String(object)} (failed serialization due to ${
              err instanceof Error ? err.message : "an error"
            })`
          }
        }

        const loggingIndex = globalLoggingIndex
        globalLoggingIndex += 1
        const startTime = Date.now()
        const labelString = () =>
          `%c[${loggingIndex.toFixed(0).padStart(4, " ")},${(
            (Date.now() - startTime) /
            1000
          )
            .toFixed(2)
            .padStart(6, " ")}s] ${marker}.${String(prop)}: ${safeSerialize(
            args,
          )}`
        const timeLoggingInterval = setInterval(() => {
          // Logging for development purposes; should not appear on prod. t
          // prefix indicates this is a timing log rather than a completion
          // log.
          // eslint-disable-next-line no-console
          console.log(
            `t${labelString()}`,
            "color: #bada55; background-color: #222;",
          )
        }, 1000)

        try {
          const result = reflected.apply(reflectedObject, args)

          Promise.resolve(result)
            .then((succesfulResult) => {
              clearInterval(timeLoggingInterval)
              // Logging for development purposes; should not appear on prod.
              // eslint-disable-next-line no-console
              console.log(
                `${labelString()}%c -> ${safeSerialize(succesfulResult)}`,
                "background: #bada55; color: #222",
                "background: #222; color: #bada55",
              )
            })
            .catch((error) => {
              clearInterval(timeLoggingInterval)
              // Logging for development purposes; should not appear on prod.
              // eslint-disable-next-line no-console
              console.log(
                `${labelString()}%c -> ${safeSerialize(error)}`,
                "background: #bada55; color: #222",
                // Error -- red background.
                "background: #dd0000; color: #bada55",
              )
            })

          return result
        } catch (err) {
          clearInterval(timeLoggingInterval)

          // Logging for development purposes; should not appear on prod.
          // eslint-disable-next-line no-console
          console.log(
            `${labelString()}%c -> ${safeSerialize(err)}`,
            "background: #bada55; color: #222",
            // Error -- red background.
            "background: #dd0000; color: #bada55",
          )

          throw err
        }
      }
    }
  }

  if (typeof reflected === "function") {
    // In production mode, still wrap reflected functions to set the `this`
    // pointer to the reflected object.
    return (...args: unknown[]) => reflected.apply(reflectedObject, args)
  }

  return reflected
}
// A tracking list of MetaMask wrappers that allow us to avoid double-wrapping.
// The map key is the provider that *was wrapped*, i.e. the original, and the
// map value is the wrapping provider, i.e. the proxy that makes sure default
// settings are respected.
const metaMaskWrapperByWrappedProvider = new Map<
  WalletProvider,
  WalletProvider
>()
let metaMaskMockWrapper: WalletProvider | undefined

function wrapMetaMaskProvider(provider: WalletProvider): {
  provider: WalletProvider
  wasMetaMaskLike: boolean
} {
  if (metaMaskWrapperByWrappedProvider.has(provider)) {
    return {
      // `get` is guarded by the `has` check above.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      provider: metaMaskWrapperByWrappedProvider.get(provider)!,
      wasMetaMaskLike: true,
    }
  }
  if (new Set(metaMaskWrapperByWrappedProvider.values()).has(provider)) {
    return { provider, wasMetaMaskLike: true }
  }

  if (
    // Rewrap MetaMask in a proxy that will route to Taho whenever Taho is
    // default.
    provider.isMetaMask === true &&
    Object.keys(provider).filter((key) => key.startsWith("is")).length === 1
  ) {
    const wrapper = new Proxy(provider, {
      get(target, prop) {
        if (
          window.walletRouter &&
          window.walletRouter.currentProvider === tahoWindowProvider &&
          tahoWindowProvider.tahoSetAsDefault &&
          tahoRoutedProperties.has(String(prop)) &&
          prop in tahoWindowProvider
        ) {
          return reflectRedirectAndDevLog(
            "TH",
            // Always proxy to the current provider, even if it has changed. This
            // allows changes in the current provider, particularly when the user
            // changes their default wallet, to take effect immediately. Combined
            // with walletRouter.routeToNewNonTahoDefault, this allows Taho to
            // effect a change in provider without a page reload or even a second
            // attempt at connecting.
            tahoWindowProvider,
            prop,
          )
        }

        return reflectRedirectAndDevLog("MM", target, prop)
      },
    })

    metaMaskWrapperByWrappedProvider.set(provider, wrapper)

    if (provider === metaMaskMock) {
      metaMaskMockWrapper = wrapper
    }

    return {
      provider: wrapper,
      wasMetaMaskLike: true,
    }
  }

  return { provider, wasMetaMaskLike: false }
}

/**
 * Returns the list of providers but with any providers that manifest as
 * MetaMask wrapped in the proxy from wrapMetaMaskProvider. If no MetaMask-like
 * provider is detected and Taho is currently set as default, also creates a
 * MetaMask mock that will allow dApps that only detect MetaMask to work with
 * Taho when it is set as default.
 */
function metaMaskWrappedProviders(
  providers: (WalletProvider | undefined)[],
): WalletProvider[] {
  const tahoIsDefault =
    window.walletRouter !== undefined &&
    window.walletRouter.currentProvider === tahoWindowProvider &&
    tahoWindowProvider.tahoSetAsDefault

  const { defaultManagedProviders, metaMaskDetected } = providers.reduce<{
    defaultManagedProviders: WalletProvider[]
    metaMaskDetected: boolean
  }>(
    // Shadowing as we're building up the final value extracted above.
    // eslint-disable-next-line @typescript-eslint/no-shadow
    ({ defaultManagedProviders, metaMaskDetected }, provider) => {
      if (provider === undefined) {
        return { defaultManagedProviders, metaMaskDetected }
      }

      // Filter out MetaMask mock if Taho has been flipped off from default.
      if (provider === metaMaskMockWrapper && !tahoIsDefault) {
        return { defaultManagedProviders, metaMaskDetected }
      }

      const { provider: defaultManaged, wasMetaMaskLike } =
        wrapMetaMaskProvider(provider)

      return {
        defaultManagedProviders: [...defaultManagedProviders, defaultManaged],
        metaMaskDetected: metaMaskDetected || wasMetaMaskLike,
      }
    },
    { defaultManagedProviders: [], metaMaskDetected: false },
  )

  if (!metaMaskDetected && tahoIsDefault) {
    const { provider: metaMaskMockProvider } =
      wrapMetaMaskProvider(metaMaskMock)
    return [metaMaskMockProvider, ...defaultManagedProviders]
  }

  return defaultManagedProviders
}

// The window object is considered unsafe, because other extensions could have modified them before this script is run.
// For 100% certainty we could create an iframe here, store the references and then destoroy the iframe.
//   something like this: https://speakerdeck.com/fransrosen/owasp-appseceu-2018-attacking-modern-web-technologies?slide=95
Object.defineProperty(window, "tally", {
  value: tahoWindowProvider,
  writable: false,
  configurable: false,
})
Object.defineProperty(window, "taho", {
  value: tahoWindowProvider,
  writable: false,
  configurable: false,
})

if (!window.walletRouter) {
  const existingProviders =
    window.ethereum !== undefined && Array.isArray(window.ethereum?.providers)
      ? window.ethereum.providers
      : [window.ethereum]

  const dedupedProviders = [
    ...new Set([
      tahoWindowProvider,
      ...metaMaskWrappedProviders(existingProviders),
    ]),
  ].filter((item) => item !== undefined)

  const wrappedLastInjectedProvider: WalletProvider | undefined =
    window.ethereum === undefined
      ? undefined
      : wrapMetaMaskProvider(window.ethereum).provider

  Object.defineProperty(window, "walletRouter", {
    value: {
      currentProvider: window.taho,
      lastInjectedProvider: wrappedLastInjectedProvider,
      tallyProvider: window.taho,
      tahoProvider: window.taho,
      providers: dedupedProviders,
      shouldSetTallyForCurrentProvider(
        shouldSetTally: boolean,
        shouldReload = false,
      ) {
        this.shouldSetTahoForCurrentProvider(shouldSetTally, shouldReload)
      },
      shouldSetTahoForCurrentProvider(
        shouldSetTaho: boolean,
        shouldReload = false,
      ) {
        if (shouldSetTaho && this.currentProvider !== this.tahoProvider) {
          this.currentProvider = this.tahoProvider
        } else if (
          !shouldSetTaho &&
          this.currentProvider === this.tahoProvider
        ) {
          this.currentProvider = this.lastInjectedProvider ?? this.tahoProvider
        }

        // Make the new "current provider" first in the provider list. This
        // makes it so that frameworks like wagmi that rely on the first item
        // in the list being the default browser wallet correctly see either
        // Taho (when default) or not-Taho (when not default).
        this.providers = [
          this.currentProvider,
          ...metaMaskWrappedProviders(
            this.providers.filter(
              (provider: WalletProvider) => provider !== this.currentProvider,
            ),
          ),
        ]

        if (
          shouldReload &&
          (window.location.href.includes("app.uniswap.org") ||
            window.location.href.includes("galxe.com"))
        ) {
          setTimeout(() => {
            window.location.reload()
          }, 1000)
        }
      },
      routeToNewNonTahoDefault(
        request: Required<RequestArgument>,
      ): Promise<unknown> {
        // Don't route to a new default if it's Taho. This avoids situations
        // where Taho is default, then default is turned off, but no other
        // provider is installed, so that we don't try to reroute back to Taho
        // as the only other provider.
        if (this.currentProvider === this.tahoProvider) {
          return Promise.reject(
            new Error("Only the Taho provider is installed."),
          )
        }
        return this.currentProvider.request(request)
      },
      getProviderInfo(provider: WalletProvider) {
        return (
          provider.providerInfo || {
            label: "Injected Provider",
            injectedNamespace: "ethereum",
            iconURL: "TODO",
          }
        )
      },
      reemitTahoEvent(event: string | symbol, ...args: unknown[]): boolean {
        if (
          this.currentProvider !== this.tahoProvider ||
          this.lastInjectedProvider === undefined ||
          this.currentProvider === this.lastInjectedProvider
        ) {
          return false
        }

        return this.lastInjectedProvider.emit(event, ...args)
      },
      setSelectedProvider() {},
      addProvider(newProvider: WalletProvider) {
        const wrappedProvider = wrapMetaMaskProvider(newProvider).provider
        if (
          !this.providers.includes(newProvider) &&
          !this.providers.includes(wrappedProvider)
        ) {
          this.providers.push(wrappedProvider)
        }

        this.lastInjectedProvider = wrappedProvider
      },
    },
    writable: false,
    configurable: false,
  })
}

// Some popular dapps depend on the entire window.ethereum equality between component renders
// to detect provider changes.  We need to cache the walletRouter proxy we return here or
// these dapps may incorrectly detect changes in the provider where there are none.
let cachedWindowEthereumProxy: WindowEthereum

// We need to save the current provider at the time we cache the proxy object,
// so we can recognize when the default wallet behavior is changed. When the
// default wallet is changed we are switching the underlying provider.
let cachedCurrentProvider: WalletProvider

Object.defineProperty(window, "ethereum", {
  get() {
    if (!window.walletRouter) {
      throw new Error(
        "window.walletRouter is expected to be set to change the injected provider on window.ethereum.",
      )
    }
    if (
      cachedWindowEthereumProxy &&
      cachedCurrentProvider === window.walletRouter.currentProvider
    ) {
      return cachedWindowEthereumProxy
    }

    if (window.walletRouter.currentProvider === undefined) {
      return undefined
    }

    cachedWindowEthereumProxy = new Proxy(window.walletRouter.currentProvider, {
      get(target, prop) {
        if (
          window.walletRouter &&
          window.walletRouter.currentProvider === tahoWindowProvider &&
          tahoWindowProvider.tahoSetAsDefault &&
          (prop === "isMetaMask" || String(prop).startsWith("_"))
        ) {
          // For MetaMask-specific properties like isMetaMask, _metamask, and others,
          // return our mock values if Taho is installed and set as default.
          // The Taho provider itself will always return `false` for isMetaMask and
          // doesn't respond to other MetaMask-specific properties, as certain
          // dApps detect a wallet that declares MetaMask-like properties AND
          // isSomethingElse and disallow the behavior we're going for here.
          return metaMaskMock[String(prop)]
        }

        if (
          window.walletRouter &&
          !(prop in window.walletRouter.currentProvider) &&
          prop in window.walletRouter
        ) {
          // let's publish the api of `window.walletRouter` also on `window.ethereum` for better discoverability

          // @ts-expect-error ts accepts symbols as index only from 4.4
          // https://stackoverflow.com/questions/59118271/using-symbol-as-object-key-type-in-typescript
          return window.walletRouter[prop]
        }

        return Reflect.get(
          // Always proxy to the current provider, even if it has changed. This
          // allows changes in the current provider, particularly when the user
          // changes their default wallet, to take effect immediately. Combined
          // with walletRouter.routeToNewNonTahoDefault, this allows Taho to
          // effect a change in provider without a page reload or even a second
          // attempt at connecting.
          window.walletRouter?.currentProvider ?? target,
          prop,
          target,
        )
      },
    })
    cachedCurrentProvider = window.walletRouter.currentProvider

    return cachedWindowEthereumProxy
  },
  set(newProvider) {
    window.walletRouter?.addProvider(newProvider)
  },
  configurable: false,
})
