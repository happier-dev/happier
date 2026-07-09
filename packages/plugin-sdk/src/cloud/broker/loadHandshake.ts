/**
 * Broker plugin/extension-load handshake (hardening finding F4).
 *
 * A broker MARKER on disk plus a reachable daemon bridge is NOT proof the broker runtime artifact
 * actually LOADED inside the agent runtime — a present-but-not-loaded file (the QA-class bug) would
 * silently fall through to no brokered auth. To close that gap:
 *  - the broker, on activation, pings the daemon over the SCOPED bridge (`CONNECTED_SERVICE_BROKER_LOADED_PATH`),
 *  - the daemon records the ping in this process-local registry keyed by the stable connected-service
 *    selection identity plus the per-spawn load nonce,
 *  - the connected-session preflight polls (bounded, fail-closed) the daemon for that record
 *    (`CONNECTED_SERVICE_BROKER_LOADED_STATUS_PATH`) before the first prompt.
 *
 * The registry is provider-agnostic (keyed by the selection identity plus load nonce, not by provider),
 * so a single daemon registry + endpoint pair serves every broker without letting an earlier spawn's
 * handshake satisfy a later process. It is intentionally in-memory: a daemon restart re-mints the master
 * control token (and thus the scoped capability token + selection identity inputs), so there is no durable
 * state to reconcile.
 */

/** Scoped-token-guarded endpoint a broker POSTs to on activation to announce it loaded. */
export const CONNECTED_SERVICE_BROKER_LOADED_PATH = '/connected-service-auth/broker/loaded';

/** Master-token-guarded endpoint Happier's own preflight polls to learn whether the broker loaded. */
export const CONNECTED_SERVICE_BROKER_LOADED_STATUS_PATH = '/connected-service-auth/broker/loaded-status';

/**
 * Freshness horizon: a recorded handshake older than this is treated as stale (defense against a
 * never-cleared registry surviving a long-lived daemon). 24h mirrors the spawn-nonce horizon.
 */
export const CONNECTED_SERVICE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export type BrokerLoadHandshakeKey = Readonly<{
  selectionIdentity: string;
  loadNonce: string;
}>;

export type BrokerLoadHandshakeRegistry = Readonly<{
  /** Record that the broker for this selection/spawn announced it loaded (defaults `atMs` to now). */
  record(key: BrokerLoadHandshakeKey, atMs?: number): void;
  /** True iff a non-stale handshake exists for this selection/spawn. Fail-closed on blank key fields. */
  wasObserved(
    key: BrokerLoadHandshakeKey,
    options?: Readonly<{ nowMs?: number; freshnessHorizonMs?: number }>,
  ): boolean;
}>;

function normalizeIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNonce(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeKey(value: BrokerLoadHandshakeKey): string {
  const identity = normalizeIdentity(value.selectionIdentity);
  const loadNonce = normalizeNonce(value.loadNonce);
  if (!identity || !loadNonce) return '';
  return `${identity}\0${loadNonce}`;
}

/**
 * Create a daemon-process-local broker load-handshake registry. One instance per daemon (the daemon
 * wiring records on the `/loaded` endpoint and answers the `/loaded-status` query from it). Shared by
 * every broker: all brokers POST their stable selection identity plus per-spawn load nonce, so a single
 * registry suffices.
 */
export function createBrokerLoadHandshakeRegistry(): BrokerLoadHandshakeRegistry {
  const observedAtMsByKey = new Map<string, number>();
  return {
    record(key, atMs) {
      const normalizedKey = normalizeKey(key);
      if (!normalizedKey) return;
      observedAtMsByKey.set(
        normalizedKey,
        typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now(),
      );
    },
    wasObserved(key, options) {
      const normalizedKey = normalizeKey(key);
      if (!normalizedKey) return false;
      const observedAtMs = observedAtMsByKey.get(normalizedKey);
      if (typeof observedAtMs !== 'number') return false;
      const nowMs = options?.nowMs ?? Date.now();
      const freshnessHorizonMs = options?.freshnessHorizonMs ?? CONNECTED_SERVICE_BROKER_LOAD_HANDSHAKE_FRESHNESS_MS;
      return nowMs - observedAtMs <= freshnessHorizonMs;
    },
  };
}
