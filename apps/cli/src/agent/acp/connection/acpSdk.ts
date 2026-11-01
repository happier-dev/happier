import type * as AcpSdkModule from '@agentclientprotocol/sdk';

/**
 * Loads `@agentclientprotocol/sdk` on first ACP connection.
 *
 * Importing the SDK builds its whole zod schema set (~2.7k instances, ~9 MB
 * private memory). Every session runner reaches this corridor through the
 * provider catalog, but only ACP sessions and probes open a connection, so
 * production code must not import SDK values statically
 * (`__tests__/acpSdk.test.ts` enforces this).
 */
export type AcpSdk = typeof AcpSdkModule;

let loaded: AcpSdk | undefined;
let loading: Promise<AcpSdk> | undefined;

export function loadAcpSdk(): Promise<AcpSdk> {
  loading ??= import('@agentclientprotocol/sdk').then(
    (sdk) => (loaded = sdk),
    (error: unknown) => {
      // Do not pin a failed load for the life of a long-lived process (daemon probes).
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/**
 * The SDK for code that only runs inside an open connection (request handlers,
 * params parsers), where `loadAcpSdk()` has necessarily resolved.
 */
export function requireLoadedAcpSdk(): AcpSdk {
  if (!loaded) throw new Error('ACP SDK used before any ACP connection was created');
  return loaded;
}

/** SDK `RequestError`s only exist once the SDK has been loaded. */
export function isAcpRequestError(error: unknown): error is AcpSdkModule.RequestError {
  return loaded !== undefined && error instanceof loaded.RequestError;
}
