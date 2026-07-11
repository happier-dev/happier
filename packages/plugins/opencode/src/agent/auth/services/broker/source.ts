import {
  buildBrokerBridgeCallSource,
  CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
} from '@happier-dev/plugin-sdk/experimental/cloud/broker';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';

import { OPEN_CODE_BROKER_REFRESH_TOKEN_PATH_ENV } from './capabilityToken.js';
import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  type OpenCodeBrokerProvider,
} from './env.js';
import { OPEN_CODE_BROKER_LOADED_PATH } from './loadHandshake.js';

/**
 * Version of the Happier OpenCode auth broker plugin. Bump on any wire-shape change. It is folded
 * into the broker marker + selection identity (so a new plugin version yields a new managed-server
 * fingerprint) and into the on-disk plugin file name (so old + new co-exist across upgrades).
 */
export const OPEN_CODE_BROKER_PLUGIN_VERSION = '1';

/** Canonical Codex backend constants (replicated from the official Codex CLI request shape). */
export const OPEN_CODE_BROKER_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const OPEN_CODE_BROKER_CODEX_RESPONSES_FROM = '/responses';
export const OPEN_CODE_BROKER_CODEX_RESPONSES_TO = '/codex/responses';
export const OPEN_CODE_BROKER_CODEX_ORIGINATOR = 'codex_cli_rs';
export const OPEN_CODE_BROKER_CODEX_OPENAI_BETA = 'responses=experimental';

/** Canonical Anthropic OAuth constants. */
export const OPEN_CODE_BROKER_ANTHROPIC_BETA = 'oauth-2025-04-20';
export const OPEN_CODE_BROKER_ANTHROPIC_SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the self-contained ESM source for the Happier OpenCode auth broker plugin for one provider.
 *
 * The returned string is written to disk and loaded by OpenCode's own Bun runtime as a local
 * plugin file. It imports NOTHING (no Happier modules, no npm deps) and uses only Bun/Node globals
 * (`fetch`, `process`, `node:fs`). It:
 *   - engages on Happier's broker auth marker (NOT on real provider tokens),
 *   - obtains a fresh ACCESS token from the Happier daemon bridge over local HTTP (the daemon is the
 *     sole refresher; NO refresh token is ever present here),
 *   - authenticates the bridge with an independent per-materialization capability reread from its
 *     private file on every request; it NEVER reads or transmits the daemon master control token,
 *   - requests a CONDITIONAL refresh (F6: `forceRefresh:false` on a cold cache-miss; `forceRefresh:true`
 *     only on a 401 retry) so the daemon rotates the single-use refresh token only when necessary,
 *   - shapes the provider request (Codex backend rewrite + headers, or Anthropic Bearer+beta),
 *   - caches the access token in-memory and refreshes once on a 401,
 *   - on activation pings the daemon load-handshake endpoint (F4) so the connected-session preflight can
 *     fail closed if the plugin never loaded — best-effort, bounded, never blocking auth.
 *
 * The bridge-call portion (daemon-state read, capability-file read, selection resolve, POST shape) is
 * emitted by the shared provider-neutral builder from this plugin's provider-owned descriptor. It defines
 * the bridge env constants plus
 * readJsonEnv/readDaemonHttpPort/readScopedToken/resolveSelection/fetchAccessTokenFromBridge. OpenCode
 * adds only the provider request-shaping, the in-memory cache, brokeredFetch, the load handshake, and
 * the OpenCode plugin factory.
 */
export function buildOpenCodeBrokerPluginSource(provider: OpenCodeBrokerProvider): string {
  const sharedBridgeCallSource = buildBrokerBridgeCallSource({
    selectionKey: provider,
    bridgePath: CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
    serviceId: provider === 'openai' ? 'openai-codex' : 'claude-subscription',
    planTypeBodyKey: provider === 'openai' ? 'chatgptPlanType' : null,
    resultAccountIdKeys: provider === 'openai' ? ['accountId', 'chatgptAccountId'] : ['accountId'],
    selectionsEnv: OPEN_CODE_BROKER_SELECTIONS_ENV,
    daemonStatePathEnv: OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
    refreshTokenPathEnv: OPEN_CODE_BROKER_REFRESH_TOKEN_PATH_ENV,
    pluginVersionEnv: OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
    pluginVersion: OPEN_CODE_BROKER_PLUGIN_VERSION,
    sessionTag: 'opencode-broker',
    selectionIdentityEnv: OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV,
  });
  return `// Happier OpenCode auth broker plugin (generated). Provider: ${provider}. Version: ${OPEN_CODE_BROKER_PLUGIN_VERSION}.
// Self-contained ESM: loaded by OpenCode's Bun runtime. No Happier imports, no npm deps.
import { readFileSync } from "node:fs";

${sharedBridgeCallSource}

const PROVIDER = ${jsString(provider)};
const SELECTION_IDENTITY_ENV = ${jsString(OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV)};
const LOAD_NONCE_ENV = ${jsString(OPEN_CODE_BROKER_LOAD_NONCE_ENV)};
const LOADED_HANDSHAKE_PATH = ${jsString(OPEN_CODE_BROKER_LOADED_PATH)};
const MARKER_PREFIX = "happier-broker";

const CODEX_BASE_URL = ${jsString(OPEN_CODE_BROKER_CODEX_BASE_URL)};
const CODEX_FROM = ${jsString(OPEN_CODE_BROKER_CODEX_RESPONSES_FROM)};
const CODEX_TO = ${jsString(OPEN_CODE_BROKER_CODEX_RESPONSES_TO)};
const CODEX_ORIGINATOR = ${jsString(OPEN_CODE_BROKER_CODEX_ORIGINATOR)};
const CODEX_OPENAI_BETA = ${jsString(OPEN_CODE_BROKER_CODEX_OPENAI_BETA)};

const ANTHROPIC_BETA = ${jsString(OPEN_CODE_BROKER_ANTHROPIC_BETA)};
const ANTHROPIC_SYSTEM_IDENTITY = ${jsString(OPEN_CODE_BROKER_ANTHROPIC_SYSTEM_IDENTITY)};

// Static, binary-safe model normalization (subset of the official Codex CLI map). No remote fetch.
const MODEL_MAP = {
  "gpt-5": "gpt-5.1",
  "gpt-5-codex": "gpt-5.1-codex",
  "gpt-5-codex-mini": "gpt-5.1-codex-mini",
  "codex-mini-latest": "gpt-5.1-codex-mini",
  "gpt-5.1": "gpt-5.1",
  "gpt-5.1-codex": "gpt-5.1-codex",
  "gpt-5.1-codex-max": "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-codex": "gpt-5.2-codex",
};

function normalizeCodexModel(model) {
  if (typeof model !== "string" || model.length === 0) return model;
  const bare = model.includes("/") ? model.split("/").pop() : model;
  if (MODEL_MAP[bare]) return MODEL_MAP[bare];
  const lower = String(bare).toLowerCase();
  for (const key of Object.keys(MODEL_MAP)) {
    if (key.toLowerCase() === lower) return MODEL_MAP[key];
    if (lower.startsWith(key.toLowerCase() + "-")) return MODEL_MAP[key];
  }
  return bare;
}

// In-memory access-token cache. Refresh ~60s before expiry; fixed conservative TTL when expiry unknown.
const DEFAULT_TTL_MS = 45 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;
let cached = null;
let inFlight = null;

async function getAccessToken(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cached && cached.notAfter > now) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const fresh = await fetchAccessTokenFromBridge(forceRefresh === true);
    const notAfter = fresh.expiresAt && fresh.expiresAt > now
      ? fresh.expiresAt - EXPIRY_SKEW_MS
      : now + DEFAULT_TTL_MS;
    cached = { accessToken: fresh.accessToken, accountId: fresh.accountId, notAfter: notAfter };
    return cached;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

function rewriteCodexUrl(url) {
  return String(url).replace(CODEX_FROM, CODEX_TO);
}

function buildCodexHeaders(init, accountId, accessToken) {
  const headers = new Headers(init && init.headers ? init.headers : {});
  headers.delete("x-api-key");
  headers.set("Authorization", "Bearer " + accessToken);
  if (accountId) headers.set("chatgpt-account-id", accountId);
  headers.set("OpenAI-Beta", CODEX_OPENAI_BETA);
  headers.set("originator", CODEX_ORIGINATOR);
  const cacheKey = init && init.__promptCacheKey ? init.__promptCacheKey : null;
  if (cacheKey) { headers.set("conversation_id", cacheKey); headers.set("session_id", cacheKey); }
  else { headers.delete("conversation_id"); headers.delete("session_id"); }
  headers.set("accept", "text/event-stream");
  return headers;
}

function transformCodexBody(init) {
  if (!init || !init.body || typeof init.body !== "string") return { init: init, promptCacheKey: null };
  let body;
  try { body = JSON.parse(init.body); } catch { return { init: init, promptCacheKey: null }; }
  if (typeof body.model === "string") body.model = normalizeCodexModel(body.model);
  body.store = false;
  const include = Array.isArray(body.include) ? body.include.slice() : [];
  if (include.indexOf("reasoning.encrypted_content") === -1) include.push("reasoning.encrypted_content");
  body.include = include;
  const promptCacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : null;
  return { init: Object.assign({}, init, { body: JSON.stringify(body) }), promptCacheKey: promptCacheKey };
}

function buildAnthropicHeaders(init, accessToken) {
  const headers = new Headers(init && init.headers ? init.headers : {});
  headers.delete("x-api-key");
  headers.set("Authorization", "Bearer " + accessToken);
  const existingBeta = headers.get("anthropic-beta");
  headers.set("anthropic-beta", existingBeta && existingBeta.indexOf(ANTHROPIC_BETA) === -1
    ? existingBeta + "," + ANTHROPIC_BETA
    : ANTHROPIC_BETA);
  if (!headers.get("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  return headers;
}

function injectAnthropicSystemIdentity(init) {
  if (!init || !init.body || typeof init.body !== "string") return init;
  let body;
  try { body = JSON.parse(init.body); } catch { return init; }
  const identity = { type: "text", text: ANTHROPIC_SYSTEM_IDENTITY };
  if (Array.isArray(body.system)) {
    const first = body.system[0];
    const firstText = first && typeof first.text === "string" ? first.text : (typeof first === "string" ? first : "");
    if (firstText !== ANTHROPIC_SYSTEM_IDENTITY) body.system = [identity].concat(body.system);
  } else if (typeof body.system === "string" && body.system.length > 0) {
    if (body.system !== ANTHROPIC_SYSTEM_IDENTITY) body.system = [identity, { type: "text", text: body.system }];
  } else {
    body.system = [identity];
  }
  return Object.assign({}, init, { body: JSON.stringify(body) });
}

async function brokeredFetch(input, init) {
  const url = typeof input === "string" ? input : (input && input.url ? input.url : String(input));
  let token = await getAccessToken(false);
  const doRequest = async (accessToken, accountId) => {
    if (PROVIDER === "openai") {
      const transformed = transformCodexBody(init);
      const headers = buildCodexHeaders(
        Object.assign({}, transformed.init, { __promptCacheKey: transformed.promptCacheKey }),
        accountId,
        accessToken,
      );
      return fetch(rewriteCodexUrl(url), Object.assign({}, transformed.init, { headers: headers }));
    }
    const withIdentity = injectAnthropicSystemIdentity(init);
    const headers = buildAnthropicHeaders(withIdentity, accessToken);
    return fetch(url, Object.assign({}, withIdentity, { headers: headers }));
  };
  let response = await doRequest(token.accessToken, token.accountId);
  if (response.status === 401) {
    token = await getAccessToken(true);
    response = await doRequest(token.accessToken, token.accountId);
  }
  return response;
}

// F4 (plugin-load handshake): on activation announce to the Happier daemon that this broker plugin
// actually LOADED in the OpenCode runtime, keyed by the stable selection identity so the preflight
// (same env) can match it. Never throws and never blocks the plugin: failures are swallowed (the
// file-existence + non-functional marker remain the fail-closed backstop). Authenticated with the
// SCOPED token (never the master).
let handshakeSent = false;
async function sendLoadHandshake() {
  if (handshakeSent) return;
  handshakeSent = true;
  try {
    const selectionIdentity = process.env[SELECTION_IDENTITY_ENV];
    if (typeof selectionIdentity !== "string" || selectionIdentity.trim().length === 0) return;
    const loadNonce = process.env[LOAD_NONCE_ENV];
    if (typeof loadNonce !== "string" || loadNonce.trim().length === 0) return;
    const httpPort = readDaemonHttpPort();
    const scopedToken = readScopedToken();
    await fetch("http://127.0.0.1:" + httpPort + LOADED_HANDSHAKE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-happier-daemon-token": scopedToken },
      body: JSON.stringify({
        selectionIdentity: selectionIdentity,
        loadNonce: loadNonce,
        provider: PROVIDER,
        pluginVersion: process.env[PLUGIN_VERSION_ENV] || PLUGIN_VERSION,
      }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined,
    }).catch(() => {});
  } catch (error) {
    // Swallow: the handshake is advisory; auth still flows via the loader + bridge.
  }
}

export const HappierOpenCodeAuthBrokerPlugin = async () => {
  // F4: fire-and-forget load handshake (never awaited, never throws — see sendLoadHandshake).
  void sendLoadHandshake();
  return {
    auth: {
      provider: PROVIDER,
      methods: [],
      loader: async (getAuth) => {
        const auth = await getAuth().catch(() => null);
        const key = auth && typeof auth.key === "string" ? auth.key : "";
        // Engage ONLY on Happier's broker marker so we never shadow a real direct credential.
        if (key.indexOf(MARKER_PREFIX + ":") !== 0) return {};
        const result = { apiKey: key, fetch: brokeredFetch };
        // Codex requests must target the ChatGPT backend; the AI SDK builds <baseURL>/responses
        // which brokeredFetch then rewrites to <baseURL>/codex/responses.
        if (PROVIDER === "openai") result.baseURL = CODEX_BASE_URL;
        return result;
      },
    },
  };
};

export default HappierOpenCodeAuthBrokerPlugin;
`;
}
