import {
  buildBrokerBridgeCallSource,
  CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
  CONNECTED_SERVICE_BROKER_LOADED_PATH,
} from '@happier-dev/plugin-sdk/experimental/cloud/broker';

import {
  PI_BROKER_DAEMON_STATE_PATH_ENV,
  PI_BROKER_EXTENSION_VERSION_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_MARKER_PREFIX,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
} from './env.js';
import { PI_BROKER_REFRESH_TOKEN_ENV } from './capabilityToken.js';

/**
 * Version of the Happier Pi auth broker extension. Bump on any wire-shape change. Folded into the
 * broker marker (stored as the credential `refresh` value) + the selection identity (so a new version
 * yields a new managed fingerprint) and into the on-disk extension file name (so old + new co-exist
 * across upgrades).
 */
export const PI_BROKER_EXTENSION_VERSION = '1';

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the self-contained Pi auth broker extension source.
 *
 * The returned string is written to `<PI_CODING_AGENT_DIR>/extensions/` and auto-discovered + loaded by
 * Pi's jiti runtime (works in the Bun-compiled binary via virtualModules; `.js`/`.ts` both discovered).
 * It imports NOTHING from Happier and uses only Node globals (`fetch`, `process`, `node:fs`). It:
 *   - registers an OAuth provider OVERRIDE for each brokered provider via `pi.registerProvider(id,
 *     { oauth })`, so Pi's built-in `anthropic`/`openai-codex` OAuth providers are replaced;
 *   - `oauth.refreshToken(cred)` fetches a fresh ACCESS token from the Happier daemon bridge (the daemon
 *     is the SOLE refresher; NO provider refresh token is ever present here) and returns a credential
 *     whose `refresh` is a non-secret Happier marker and whose `expires` tracks the brokered token's
 *     real lifetime (so Pi re-brokers exactly when the access token expires);
 *   - `oauth.getApiKey(cred)` returns the brokered access token; Pi self-shapes the provider request
 *     headers from the token value (`sk-ant-oat` → Bearer + Claude-Code identity; Codex JWT →
 *     `chatgpt-account-id` + Bearer) — so the broker needs no custom fetch / URL rewrite / model map;
 *   - `oauth.login` throws: login happens in Happier, never in the brokered runtime;
 *   - pings the daemon load-handshake once on activation (scoped token, bounded) so the preflight can
 *     confirm the extension actually loaded.
 *
 * A single extension file registers EVERY brokered provider present in the selections env (Pi loads it
 * once and it self-selects), so there is exactly one extension artifact per session — simpler than one
 * file per provider and free of inter-file load races.
 */
export function buildPiBrokerExtensionSource(): string {
  // The bridge-call portion is emitted by the shared descriptor-driven builder for both providers. Emit
  // one block per provider and scope each with an IIFE so the generated top-level names do not collide.
  const anthropicBridge = buildBrokerBridgeCallSource({
    selectionKey: 'anthropic',
    bridgePath: CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
    serviceId: 'claude-subscription',
    resultAccountIdKeys: ['accountId'],
    selectionsEnv: PI_BROKER_SELECTIONS_ENV,
    daemonStatePathEnv: PI_BROKER_DAEMON_STATE_PATH_ENV,
    refreshTokenEnv: PI_BROKER_REFRESH_TOKEN_ENV,
    pluginVersionEnv: PI_BROKER_EXTENSION_VERSION_ENV,
    pluginVersion: PI_BROKER_EXTENSION_VERSION,
    sessionTag: 'pi-broker',
    selectionIdentityEnv: PI_BROKER_SELECTION_IDENTITY_ENV,
  });
  const codexBridge = buildBrokerBridgeCallSource({
    selectionKey: 'openai',
    bridgePath: CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
    serviceId: 'openai-codex',
    planTypeBodyKey: 'chatgptPlanType',
    resultAccountIdKeys: ['accountId', 'chatgptAccountId'],
    selectionsEnv: PI_BROKER_SELECTIONS_ENV,
    daemonStatePathEnv: PI_BROKER_DAEMON_STATE_PATH_ENV,
    refreshTokenEnv: PI_BROKER_REFRESH_TOKEN_ENV,
    pluginVersionEnv: PI_BROKER_EXTENSION_VERSION_ENV,
    pluginVersion: PI_BROKER_EXTENSION_VERSION,
    sessionTag: 'pi-broker',
    selectionIdentityEnv: PI_BROKER_SELECTION_IDENTITY_ENV,
  });

  return `// Happier Pi auth broker extension (generated). Version: ${PI_BROKER_EXTENSION_VERSION}.
// Self-contained: loaded by Pi's jiti runtime. No Happier imports, no npm deps.
import { readFileSync } from "node:fs";

const SELECTIONS_ENV = ${jsString(PI_BROKER_SELECTIONS_ENV)};
const DAEMON_STATE_PATH_ENV = ${jsString(PI_BROKER_DAEMON_STATE_PATH_ENV)};
const REFRESH_TOKEN_ENV = ${jsString(PI_BROKER_REFRESH_TOKEN_ENV)};
const EXTENSION_VERSION_ENV = ${jsString(PI_BROKER_EXTENSION_VERSION_ENV)};
const SELECTION_IDENTITY_ENV = ${jsString(PI_BROKER_SELECTION_IDENTITY_ENV)};
const LOAD_NONCE_ENV = ${jsString(PI_BROKER_LOAD_NONCE_ENV)};
const EXTENSION_VERSION = ${jsString(PI_BROKER_EXTENSION_VERSION)};
const LOADED_HANDSHAKE_PATH = ${jsString(CONNECTED_SERVICE_BROKER_LOADED_PATH)};
const MARKER_PREFIX = ${jsString(PI_BROKER_MARKER_PREFIX)};
const EXPIRY_SKEW_MS = 60 * 1000;
const DEFAULT_TTL_MS = 45 * 60 * 1000;

// Per-provider bridge fetcher (shared source, block-scoped to avoid name collisions across providers).
const fetchAnthropicAccessTokenFromBridge = (() => {
${anthropicBridge}
  return fetchAccessTokenFromBridge;
})();
const fetchCodexAccessTokenFromBridge = (() => {
${codexBridge}
  return fetchAccessTokenFromBridge;
})();

// Bridge tag (openai/anthropic) keys the fetcher + selections; Pi's provider id (openai-codex/anthropic)
// keys registerProvider + the auth.json marker. Map between them.
function fetcherForTag(bridgeTag) {
  return bridgeTag === "openai" ? fetchCodexAccessTokenFromBridge : fetchAnthropicAccessTokenFromBridge;
}
function registerProviderIdForTag(bridgeTag) {
  return bridgeTag === "openai" ? "openai-codex" : "anthropic";
}

function readScopedTokenForHandshake() {
  const token = process.env[REFRESH_TOKEN_ENV];
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
}

function readDaemonHttpPortForHandshake() {
  const path = process.env[DAEMON_STATE_PATH_ENV];
  if (typeof path !== "string" || path.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed.httpPort === "number" ? parsed.httpPort : null;
  } catch {
    return null;
  }
}

function readJsonEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// In-memory access-token cache per provider, so multiple turns inside the access-token lifetime do not
// each hit the bridge. The daemon's per-binding single-flight is the cross-process safety net.
const cacheByProvider = Object.create(null);
const inFlightByProvider = Object.create(null);

async function brokeredAccessToken(bridgeTag, forceRefresh) {
  const now = Date.now();
  const cached = cacheByProvider[bridgeTag];
  if (!forceRefresh && cached && cached.notAfter > now) return cached;
  if (inFlightByProvider[bridgeTag]) return inFlightByProvider[bridgeTag];
  inFlightByProvider[bridgeTag] = (async () => {
    const fresh = await fetcherForTag(bridgeTag)(forceRefresh === true);
    const notAfter = fresh.expiresAt && fresh.expiresAt > now ? fresh.expiresAt - EXPIRY_SKEW_MS : now + DEFAULT_TTL_MS;
    const entry = { accessToken: fresh.accessToken, accountId: fresh.accountId, expiresAt: fresh.expiresAt, notAfter: notAfter };
    cacheByProvider[bridgeTag] = entry;
    return entry;
  })();
  try { return await inFlightByProvider[bridgeTag]; } finally { inFlightByProvider[bridgeTag] = null; }
}

// Build the OAuth provider override Pi registers. Pi calls:
//   - getApiKey(cred): when the stored cred is NOT expired, returns cred.access directly (no bridge).
//   - refreshToken(cred): when the stored cred IS expired, fetches a fresh access token from the
//     daemon bridge and returns a NEW credential. The returned refresh value is a non-secret Happier
//     marker (NEVER a real provider refresh token); expires tracks the brokered access token lifetime
//     so Pi re-brokers exactly when it lapses. Pi persists this back to auth.json - still no real
//     refresh token on disk.
function buildOauthOverride(bridgeTag) {
  const registerProviderId = registerProviderIdForTag(bridgeTag);
  return {
    name: "Happier (brokered)",
    async login() {
      throw new Error("happier_pi_broker_login_unsupported: connect this account in Happier, not in Pi.");
    },
    async refreshToken(credentials) {
      const fresh = await brokeredAccessToken(bridgeTag, false);
      const expires = fresh.expiresAt && fresh.expiresAt > Date.now() ? fresh.expiresAt : Date.now() + DEFAULT_TTL_MS;
      const next = Object.assign({}, credentials, {
        refresh: MARKER_PREFIX + ":" + registerProviderId + ":" + (process.env[EXTENSION_VERSION_ENV] || EXTENSION_VERSION),
        access: fresh.accessToken,
        expires: expires,
      });
      if (fresh.accountId) next.accountId = fresh.accountId;
      return next;
    },
    getApiKey(credentials) {
      const access = credentials && typeof credentials.access === "string" ? credentials.access : "";
      if (access && access.length > 0) return access;
      // Defensive: a brokered cred with no usable access (e.g. first turn before any refresh). The
      // caller (Pi) treats a thrown getApiKey as a hard auth failure, which is correct fail-closed
      // behavior — we never silently fall back to a provider token.
      throw new Error("happier_pi_broker_no_access_token");
    },
  };
}

// Best-effort, bounded load handshake: tell the daemon this broker extension actually loaded, keyed by
// the stable selection identity so the preflight (same env) can match it. Never throws / never blocks.
let handshakeSent = false;
async function sendLoadHandshake(providers) {
  if (handshakeSent) return;
  handshakeSent = true;
  try {
    const selectionIdentity = process.env[SELECTION_IDENTITY_ENV];
    if (typeof selectionIdentity !== "string" || selectionIdentity.trim().length === 0) return;
    const loadNonce = process.env[LOAD_NONCE_ENV];
    if (typeof loadNonce !== "string" || loadNonce.trim().length === 0) return;
    const httpPort = readDaemonHttpPortForHandshake();
    const scopedToken = readScopedTokenForHandshake();
    if (!httpPort || !scopedToken || providers.length === 0) return;
    await fetch("http://127.0.0.1:" + httpPort + LOADED_HANDSHAKE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-happier-daemon-token": scopedToken },
      body: JSON.stringify({
        selectionIdentity: selectionIdentity,
        loadNonce: loadNonce,
        providers: providers,
        pluginVersion: process.env[EXTENSION_VERSION_ENV] || EXTENSION_VERSION,
      }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined,
    }).catch(() => {});
  } catch (error) {
    // Swallow: the handshake is advisory; auth still flows via registerProvider + the bridge.
  }
}

// Pi extension factory: registers a brokered OAuth provider override for each brokered provider present
// in the selections env. Pi auto-discovers + invokes this with its ExtensionAPI.
export default async function HappierPiAuthBrokerExtension(pi) {
  // Selections are keyed by the SHARED bridge tag (openai/anthropic). Register each present provider
  // under Pi's own provider id (openai-codex/anthropic), overriding its built-in OAuth provider. The
  // load handshake reports the bridge tags (which the daemon schema accepts).
  const selections = readJsonEnv(SELECTIONS_ENV) || {};
  const registeredTags = [];
  for (const bridgeTag of ["openai", "anthropic"]) {
    if (!selections[bridgeTag]) continue;
    if (pi && typeof pi.registerProvider === "function") {
      pi.registerProvider(registerProviderIdForTag(bridgeTag), { oauth: buildOauthOverride(bridgeTag) });
      registeredTags.push(bridgeTag);
    }
  }
  void sendLoadHandshake(registeredTags);
}
`;
}
