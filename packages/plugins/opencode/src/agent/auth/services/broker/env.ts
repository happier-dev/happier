/**
 * Shared env-var names + marker helpers for the Happier OpenCode auth broker.
 *
 * The materializer (connected-services) sets these env vars on the managed `opencode serve`
 * process; the broker plugin (running inside OpenCode's Bun runtime) reads them. Keeping the
 * names in one module keeps the producer (materializer) and consumer (plugin source) in lockstep
 * — a contract test asserts the emitted plugin source references each name.
 *
 * NO secret (refresh token, daemon control token) is ever placed in these env values. The broker
 * obtains access tokens out-of-band from the Happier daemon bridge and reads the daemon control
 * token from the daemon-state file (0600) at call time, not from the env.
 */

/** JSON map of brokered providers → their refresh selection + account identity (NO tokens). */
export const OPEN_CODE_BROKER_SELECTIONS_ENV = 'HAPPIER_OPENCODE_BROKER_SELECTIONS';

/** Absolute path to the Happier daemon-state file (carries `httpPort`/`controlToken`). Not secret. */
export const OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV = 'HAPPIER_OPENCODE_BROKER_DAEMON_STATE_PATH';

/** Broker plugin version (for cache-keying + drift diagnostics). */
export const OPEN_CODE_BROKER_PLUGIN_VERSION_ENV = 'HAPPIER_OPENCODE_BROKER_PLUGIN_VERSION';

/** Per-managed-server-process nonce that correlates the broker load handshake to the current spawn. */
export const OPEN_CODE_BROKER_LOAD_NONCE_ENV = 'HAPPIER_OPENCODE_BROKER_LOAD_NONCE';

/**
 * Scoped broker-refresh capability token env var (hardening finding F2). The materializer derives this
 * NARROW token (HMAC of the daemon master control token, scoped to broker-refresh only) and injects it
 * here; the broker reads it from the env and presents it to the daemon bridge. The MASTER control token
 * is NEVER placed here — the broker holds only this least-privilege token. See `capabilityToken.ts`.
 */
export { OPEN_CODE_BROKER_REFRESH_TOKEN_ENV } from './capabilityToken.js';

/** Stable, non-secret prefix for the broker auth marker stored in `OPENCODE_AUTH_CONTENT`. */
export const OPEN_CODE_BROKER_MARKER_PREFIX = 'happier-broker';

export type OpenCodeBrokerProvider = 'openai' | 'anthropic';

/** Connected service ids brokered through Happier's daemon (NOT the direct API-key services). */
export type OpenCodeBrokerServiceId = 'openai-codex' | 'claude-subscription';

export type OpenCodeBrokerProviderSelection = Readonly<{
  serviceId: OpenCodeBrokerServiceId;
  profileId: string;
  /** Provider account id (e.g. ChatGPT account id) for request headers. Stable, not secret. */
  accountId: string | null;
  /** Provider plan label echoed back for telemetry; optional. */
  planType: string | null;
}>;

export type OpenCodeBrokerSelections = Readonly<
  Partial<Record<OpenCodeBrokerProvider, OpenCodeBrokerProviderSelection>>
>;

export const OPEN_CODE_BROKER_PROVIDERS: readonly OpenCodeBrokerProvider[] = ['openai', 'anthropic'];

/** Build the stable, non-refreshable broker marker stored as the OpenCode auth `key`. */
export function buildOpenCodeBrokerMarker(provider: OpenCodeBrokerProvider, version: string): string {
  return `${OPEN_CODE_BROKER_MARKER_PREFIX}:${provider}:${version}`;
}

export function isOpenCodeBrokerMarker(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${OPEN_CODE_BROKER_MARKER_PREFIX}:`);
}

export function readOpenCodeBrokerMarkerProvider(value: unknown): OpenCodeBrokerProvider | null {
  if (!isOpenCodeBrokerMarker(value)) return null;
  const parts = (value as string).split(':');
  const provider = parts[1];
  return provider === 'openai' || provider === 'anthropic' ? provider : null;
}

export function serializeOpenCodeBrokerSelections(selections: OpenCodeBrokerSelections): string {
  return JSON.stringify(selections);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSelection(value: unknown, provider: OpenCodeBrokerProvider): OpenCodeBrokerProviderSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedServiceId: OpenCodeBrokerServiceId = provider === 'openai' ? 'openai-codex' : 'claude-subscription';
  const serviceId = readString(record.serviceId);
  const profileId = readString(record.profileId);
  if (serviceId !== expectedServiceId || !profileId) return null;
  return {
    serviceId: expectedServiceId,
    profileId,
    accountId: readString(record.accountId),
    planType: readString(record.planType),
  };
}

export function parseOpenCodeBrokerSelections(raw: unknown): OpenCodeBrokerSelections {
  const text = readString(raw);
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const source = parsed as Record<string, unknown>;
  const result: { -readonly [K in OpenCodeBrokerProvider]?: OpenCodeBrokerProviderSelection } = {};
  for (const provider of OPEN_CODE_BROKER_PROVIDERS) {
    const selection = readSelection(source[provider], provider);
    if (selection) result[provider] = selection;
  }
  return result;
}
