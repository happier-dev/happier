import {
  refreshServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from './serverFeaturesClient';

/**
 * Daemon-wide cached server-features snapshot (G9-E).
 *
 * The runtime-action front door (`dispatchExecutionRunRpcAction`) gates server-represented action
 * families through a SYNCHRONOUS `getServerFeaturesSnapshot()` accessor handed across the Api
 * provider bridge. Without a daemon-wide source backing that accessor, every server-represented
 * family fails closed on a cold daemon even when the server enables it. This store is the single
 * owner of that source: it fetches/caches the `/v1/features` snapshot the daemon already uses and
 * exposes a pure synchronous read for the gate plus an async `refresh()` the daemon primes at
 * startup, on connection changes, and at the existing active Home-indexing deadline.
 *
 * Freshness/availability semantics:
 * - `getSnapshot()` is pure (no side effects) so the gate read path stays deterministic.
 * - A `ready` fetch always updates the cache.
 * - A transient `error`/`unsupported` result NEVER clobbers a last-known-good `ready` snapshot, so
 *   a network blip cannot flip enabled features closed daemon-wide. The very first result on a cold
 *   cache is always recorded (so a server that has the endpoint missing is honestly surfaced).
 * - Concurrent `refresh()` calls share a single in-flight fetch.
 */
export type ServerFeaturesSnapshotStore = Readonly<{
  getSnapshot(): CliServerFeaturesSnapshot | undefined;
  /** True only while the current parsed Home capability is actively indexing. */
  isRefreshTransitionActive(): boolean;
  refresh(): Promise<CliServerFeaturesSnapshot | undefined>;
}>;

/** Session-control reads share the daemon source and its lifecycle refresh owner. */
export async function readServerFeaturesSnapshot(
  store: ServerFeaturesSnapshotStore,
  refresh: () => Promise<CliServerFeaturesSnapshot | undefined>,
): Promise<CliServerFeaturesSnapshot | undefined> {
  return store.getSnapshot() ?? refresh();
}

export function createServerFeaturesSnapshotStore(params: {
  // The fetch source. Defaults to the canonical `/v1/features` client so the daemon does not
  // introduce a second fetch path.
  fetchSnapshot: () => Promise<CliServerFeaturesSnapshot>;
  /** Exact-projection side effects; public predecessor fallback never reaches this callback. */
  onAuthenticatedReady?: (
    features: Extract<CliServerFeaturesSnapshot, { status: 'ready' }>['features'],
  ) => Promise<void> | void;
  onError?: (error: unknown) => void;
}): ServerFeaturesSnapshotStore {
  let cached: CliServerFeaturesSnapshot | undefined;
  let inFlight: Promise<CliServerFeaturesSnapshot | undefined> | null = null;

  const refresh = (): Promise<CliServerFeaturesSnapshot | undefined> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const next = await params.fetchSnapshot();
        if (next.status === 'ready' && next.provenance === 'authenticated') {
          await params.onAuthenticatedReady?.(next.features);
        }
        if (next.status === 'ready' || cached === undefined) {
          cached = next;
        }
        return cached;
      } catch (error) {
        params.onError?.(error);
        return cached;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    getSnapshot: () => cached,
    isRefreshTransitionActive: () => cached?.status === 'ready'
      && cached.features.capabilities.homeSearch?.reason === 'indexing',
    refresh,
  };
}

/**
 * Convenience constructor that binds the store to the canonical `/v1/features` fetch client for a
 * given server URL. The daemon uses this so the synchronous front-door gate accessor is backed by
 * the same fetch source as the local-services inventory and browser daemon gates.
 */
export function createServerUrlServerFeaturesSnapshotStore(params: {
  serverUrl: string | (() => string);
  token?: string;
  timeoutMs?: number;
  onAuthenticatedReady?: (
    features: Extract<CliServerFeaturesSnapshot, { status: 'ready' }>['features'],
  ) => Promise<void> | void;
  onError?: (error: unknown) => void;
}): ServerFeaturesSnapshotStore {
  return createServerFeaturesSnapshotStore({
    fetchSnapshot: () =>
      refreshServerFeaturesSnapshot({
        serverUrl: typeof params.serverUrl === 'function' ? params.serverUrl() : params.serverUrl,
        ...(params.token ? { token: params.token } : {}),
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
      }),
    ...(params.onError ? { onError: params.onError } : {}),
    ...(params.onAuthenticatedReady ? { onAuthenticatedReady: params.onAuthenticatedReady } : {}),
  });
}
