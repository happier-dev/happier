/**
 * Env-var names + selection/marker helpers for the Happier Pi auth broker extension.
 *
 * The Pi connected-services materializer sets these env vars on the spawned Pi process; the broker
 * extension (loaded inside Pi's jiti runtime from `<PI_CODING_AGENT_DIR>/extensions/`) reads them. They
 * carry NO secret — the OAuth refresh token never leaves the Happier daemon. The broker obtains a fresh
 * ACCESS token out-of-band from the daemon bridge and authenticates with the private
 * per-materialization capability file.
 *
 * The broker SELECTIONS are keyed by the SHARED bridge provider tag (`openai`/`anthropic`) — identical
 * to the OpenCode broker — so the SHARED bridge-call source resolves them with no per-provider glue.
 * Pi's own provider ids (`openai-codex`/`anthropic`, used for `pi.registerProvider` + the `auth.json`
 * entry key) are derived from the tag where needed.
 */

/** JSON map of brokered bridge tags → their refresh selection + account identity (NO tokens). */
export const PI_BROKER_SELECTIONS_ENV = 'HAPPIER_PI_BROKER_SELECTIONS';

/** Absolute path to the private Happier daemon-state file used for daemon discovery. */
export const PI_BROKER_DAEMON_STATE_PATH_ENV = 'HAPPIER_PI_BROKER_DAEMON_STATE_PATH';

/** Broker extension version (for the bridge sessionId + drift diagnostics). */
export const PI_BROKER_EXTENSION_VERSION_ENV = 'HAPPIER_PI_BROKER_EXTENSION_VERSION';

/** Per-Pi-process nonce that correlates the broker load handshake to the current spawn. */
export const PI_BROKER_LOAD_NONCE_ENV = 'HAPPIER_PI_BROKER_LOAD_NONCE';

export { PI_BROKER_REFRESH_TOKEN_PATH_ENV } from './capabilityToken.js';

/**
 * Stable connected-service selection identity. The broker reads it to key its load handshake so the
 * preflight (which has the same env) can match the registration. Pi-scoped name; the daemon handshake
 * registry is provider-agnostic (keyed by this identity string).
 */
export const PI_BROKER_SELECTION_IDENTITY_ENV = 'HAPPIER_PI_CONNECTED_SERVICE_SELECTION_IDENTITY';

/**
 * Stable, non-secret marker stored as the `refresh` value of the brokered Pi OAuth credential in
 * `auth.json`. It is deliberately NOT a usable provider refresh token: Pi never refreshes against the
 * provider; it calls the broker's `refreshToken`, which hits the Happier daemon bridge. The marker lets
 * the broker (and a human auditor) recognise a brokered credential and keep `auth.json` self-describing.
 */
export const PI_BROKER_MARKER_PREFIX = 'happier-pi-broker';

/**
 * SHARED bridge provider tag (matches the OpenCode broker + the shared bridge-call source). `openai` is
 * the ChatGPT/Codex subscription lane; `anthropic` is the Claude-subscription lane.
 */
export type PiBrokerProvider = 'openai' | 'anthropic';

/** Connected service ids brokered through Happier's daemon (NOT the direct API-key services). */
export type PiBrokerServiceId = 'openai-codex' | 'claude-subscription';

/** Pi's built-in OAuth provider id overridden via `pi.registerProvider(<id>, { oauth })`. */
export type PiRegisterProviderId = 'openai-codex' | 'anthropic';

export const PI_BROKER_PROVIDERS: readonly PiBrokerProvider[] = ['openai', 'anthropic'];

export type PiBrokerProviderSelection = Readonly<{
  serviceId: PiBrokerServiceId;
  profileId: string;
  /** Provider account id (e.g. ChatGPT account id) for telemetry; stable, not secret. */
  accountId: string | null;
  /** Provider plan label echoed back for telemetry; optional. */
  planType: string | null;
}>;

export type PiBrokerSelections = Readonly<Partial<Record<PiBrokerProvider, PiBrokerProviderSelection>>>;

/** The connected service id behind a Pi broker bridge tag. */
export function piBrokerServiceId(provider: PiBrokerProvider): PiBrokerServiceId {
  return provider === 'openai' ? 'openai-codex' : 'claude-subscription';
}

/** Pi's `registerProvider` id (and `auth.json` entry key) for a bridge tag. */
export function piRegisterProviderId(provider: PiBrokerProvider): PiRegisterProviderId {
  return provider === 'openai' ? 'openai-codex' : 'anthropic';
}

/** Build the stable, non-refreshable broker marker stored as the Pi OAuth `refresh` value. */
export function buildPiBrokerMarker(registerProviderId: PiRegisterProviderId, version: string): string {
  return `${PI_BROKER_MARKER_PREFIX}:${registerProviderId}:${version}`;
}

export function isPiBrokerMarker(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${PI_BROKER_MARKER_PREFIX}:`);
}

export function serializePiBrokerSelections(selections: PiBrokerSelections): string {
  return JSON.stringify(selections);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSelection(value: unknown, provider: PiBrokerProvider): PiBrokerProviderSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedServiceId = piBrokerServiceId(provider);
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

export function parsePiBrokerSelections(raw: unknown): PiBrokerSelections {
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
  const result: { -readonly [K in PiBrokerProvider]?: PiBrokerProviderSelection } = {};
  for (const provider of PI_BROKER_PROVIDERS) {
    const selection = readSelection(source[provider], provider);
    if (selection) result[provider] = selection;
  }
  return result;
}
