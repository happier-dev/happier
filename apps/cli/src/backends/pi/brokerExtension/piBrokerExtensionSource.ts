import {
  buildBrokerBridgeCallSource,
  CONNECTED_SERVICE_BROKER_LOADED_HANDSHAKE_PATH,
} from '@/daemon/connectedServices/broker/brokerBridgeCallSource';
import {
  CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH,
  CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_SERVICE_ID,
} from '@/backends/claude/connectedServices/claudeSubscriptionAuthTokensRefreshBridgeContract';
import {
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH,
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_SERVICE_ID,
} from '@/backends/codex/connectedServices/codexChatGptAuthTokensRefreshBridgeContract';

import {
  PI_BROKER_STATE_PATH_ENV,
  PI_BROKER_EXTENSION_VERSION_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_MARKER_PREFIX,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  type PiBrokerProvider,
} from './piBrokerExtensionEnv';

/**
 * First publishable version of the Happier Pi auth broker extension. It is folded into the broker
 * marker (stored as the credential `refresh` value) + selection identity so a future breaking
 * revision yields a new managed fingerprint. The generated filename remains stable.
 */
export const PI_BROKER_EXTENSION_VERSION = '1';

function jsString(value: string): string {
  return JSON.stringify(value);
}

function resolvePiBrokerBridgeParams(provider: PiBrokerProvider) {
  if (provider === 'openai') {
    return {
      providerTag: provider,
      bridgePath: CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH,
      serviceId: CODEX_CHATGPT_AUTH_TOKENS_REFRESH_SERVICE_ID,
      planTypeBodyField: 'chatgptPlanType',
      accountIdResultFields: ['accountId', 'chatgptAccountId'] as const,
    };
  }
  return {
    providerTag: provider,
    bridgePath: CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH,
    serviceId: CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_SERVICE_ID,
    accountIdResultFields: ['accountId', 'anthropicAccountId'] as const,
  };
}

/**
 * Build the self-contained Pi auth broker extension source.
 *
 * The returned string is written to `<PI_CODING_AGENT_DIR>/extensions/` and loaded through Pi's
 * `--extension` CLI argument by the Happier Pi launcher.
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
  // The bridge-call portion is emitted by the SHARED builder for BOTH providers, keeping Pi + OpenCode
  // in lockstep. We parameterize per-provider call sites by passing the provider tag explicitly to a
  // generic fetcher (the shared builder hardcodes one provider per emission, so emit one per provider
  // and namespace them).
  const anthropicBridge = buildBrokerBridgeCallSource({
    ...resolvePiBrokerBridgeParams('anthropic'),
    selectionsEnv: PI_BROKER_SELECTIONS_ENV,
    brokerStatePathEnv: PI_BROKER_STATE_PATH_ENV,
    pluginVersionEnv: PI_BROKER_EXTENSION_VERSION_ENV,
    pluginVersion: PI_BROKER_EXTENSION_VERSION,
    sessionTag: 'pi-broker',
    selectionIdentityEnv: PI_BROKER_SELECTION_IDENTITY_ENV,
  });
  const codexBridge = buildBrokerBridgeCallSource({
    ...resolvePiBrokerBridgeParams('openai'),
    selectionsEnv: PI_BROKER_SELECTIONS_ENV,
    brokerStatePathEnv: PI_BROKER_STATE_PATH_ENV,
    pluginVersionEnv: PI_BROKER_EXTENSION_VERSION_ENV,
    pluginVersion: PI_BROKER_EXTENSION_VERSION,
    sessionTag: 'pi-broker',
    selectionIdentityEnv: PI_BROKER_SELECTION_IDENTITY_ENV,
  });

  // The shared builder defines top-level `const`/`function` names; emit each provider's bridge call
  // inside its own block scope (an IIFE returning the fetcher) so the two emissions don't collide.
  return `// Happier Pi auth broker extension (generated). Version: ${PI_BROKER_EXTENSION_VERSION}.
// Self-contained: loaded by Pi's jiti runtime. No Happier imports, no npm deps.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SELECTIONS_ENV = ${jsString(PI_BROKER_SELECTIONS_ENV)};
const BROKER_STATE_PATH_ENV = ${jsString(PI_BROKER_STATE_PATH_ENV)};
const EXTENSION_VERSION_ENV = ${jsString(PI_BROKER_EXTENSION_VERSION_ENV)};
const SELECTION_IDENTITY_ENV = ${jsString(PI_BROKER_SELECTION_IDENTITY_ENV)};
const LOAD_NONCE_ENV = ${jsString(PI_BROKER_LOAD_NONCE_ENV)};
const EXTENSION_VERSION = ${jsString(PI_BROKER_EXTENSION_VERSION)};
const LOADED_HANDSHAKE_PATH = ${jsString(CONNECTED_SERVICE_BROKER_LOADED_HANDSHAKE_PATH)};
const MARKER_PREFIX = ${jsString(PI_BROKER_MARKER_PREFIX)};
const EXPIRY_SKEW_MS = 60 * 1000;
const DEFAULT_TTL_MS = 45 * 60 * 1000;
const BROKER_EPOCH_TTL_MS = 10 * 1000;

// Per-provider bridge fetcher (shared source, block-scoped to avoid name collisions across providers).
const anthropicBridge = (() => {
${anthropicBridge}
  return { fetchAccessTokenFromBridge, readCurrentBrokerEndpoint };
})();
const codexBridge = (() => {
${codexBridge}
  return { fetchAccessTokenFromBridge, readCurrentBrokerEndpoint };
})();

// Bridge tag (openai/anthropic) keys the fetcher + selections; Pi's provider id (openai-codex/anthropic)
// keys registerProvider + the auth.json marker. Map between them.
function fetcherForTag(bridgeTag) {
  return bridgeTag === "openai"
    ? codexBridge.fetchAccessTokenFromBridge
    : anthropicBridge.fetchAccessTokenFromBridge;
}
function registerProviderIdForTag(bridgeTag) {
  return bridgeTag === "openai" ? "openai-codex" : "anthropic";
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
  if (!forceRefresh && cached && cached.notAfter > now && cached.selectionEpoch === null) return cached;
  if (inFlightByProvider[bridgeTag]) return inFlightByProvider[bridgeTag];
  inFlightByProvider[bridgeTag] = (async () => {
    const failingAccessToken = forceRefresh === true && cached ? cached.accessToken : null;
    const fresh = await fetcherForTag(bridgeTag)(forceRefresh === true, failingAccessToken);
    const notAfter = fresh.expiresAt && fresh.expiresAt > now ? fresh.expiresAt - EXPIRY_SKEW_MS : now + DEFAULT_TTL_MS;
    const entry = { accessToken: fresh.accessToken, accountId: fresh.accountId, expiresAt: fresh.expiresAt, notAfter: notAfter, selectionEpoch: fresh.selectionEpoch };
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
      const effectiveExpires = fresh.selectionEpoch === null ? expires : Math.min(expires, Date.now() + BROKER_EPOCH_TTL_MS);
      const next = Object.assign({}, credentials, {
        refresh: MARKER_PREFIX + ":" + registerProviderId + ":" + (process.env[EXTENSION_VERSION_ENV] || EXTENSION_VERSION),
        access: fresh.accessToken,
        expires: effectiveExpires,
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

// Publish mandatory activation proof without blocking the Pi extension loader. Each request is
// bounded, and a rejected/unreachable daemon remains eligible until this exact activation receives
// an acknowledgement or the owning Pi process is stopped.
const LOAD_HANDSHAKE_RETRY_MS = 250;
let handshakeSent = false;
async function sendLoadHandshake(providers) {
  if (handshakeSent) return;
  const selectionIdentity = process.env[SELECTION_IDENTITY_ENV];
  if (typeof selectionIdentity !== "string" || selectionIdentity.trim().length === 0) return;
  const loadNonce = process.env[LOAD_NONCE_ENV];
  if (typeof loadNonce !== "string" || loadNonce.trim().length === 0) return;
  if (providers.length === 0) return;
  try {
    const daemonEndpoint = anthropicBridge.readCurrentBrokerEndpoint();
    const response = await fetch("http://127.0.0.1:" + daemonEndpoint.httpPort + LOADED_HANDSHAKE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-happier-daemon-token": daemonEndpoint.scopedToken },
      body: JSON.stringify({
        runtimeKind: "pi_rpc_process",
        selectionIdentity: selectionIdentity,
        loadNonce: loadNonce,
        providers: providers,
        pluginVersion: process.env[EXTENSION_VERSION_ENV] || EXTENSION_VERSION,
        processPid: process.pid,
      }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined,
    });
    if (response.ok) handshakeSent = true;
  } catch (error) {
    // The readiness owner reports a terminal failure if proof never arrives. Keep this producer
    // eligible for transient state-file, daemon-replacement, and transport failures in the meantime.
  } finally {
    if (!handshakeSent) {
      const retry = setTimeout(() => void sendLoadHandshake(providers), LOAD_HANDSHAKE_RETRY_MS);
      retry.unref?.();
    }
  }
}

// Pi extension factory: registers a brokered OAuth provider override for each brokered provider present
// in the selections env. Happier passes this generated file through Pi's --extension argument.
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
