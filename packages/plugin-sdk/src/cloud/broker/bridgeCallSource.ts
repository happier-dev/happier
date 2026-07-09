/**
 * Shared bridge-call source for connected-service auth brokers.
 *
 * Broker runtime artifacts need the identical daemon-bridge call: read the daemon HTTP port from the
 * 0600 daemon-state file, read the SCOPED broker-refresh capability token from runtime env, resolve
 * the brokered selection, and POST to the daemon bridge to obtain a fresh ACCESS token. The daemon is
 * the sole refresher; no refresh token is ever present in the broker runtime.
 *
 * Factoring this into one stringified builder keeps runtime artifacts in lockstep on the bridge call
 * mechanics. The concrete selection key, daemon route, service id, optional metadata fields, and
 * provider response aliases stay with the owning broker package.
 *
 * The emitted source is self-contained ESM-statement JS that imports only `node:fs` `readFileSync` and
 * uses `fetch`/`process` globals. It defines:
 *   - `fetchAccessTokenFromBridge(forceRefresh)` → `{ accessToken, accountId, expiresAt }`
 *   - `readDaemonHttpPort()`, `readScopedToken()` (also used by a broker's load handshake)
 * Callers must place `import { readFileSync } from "node:fs";` at the top of the assembled module.
 */

export type BrokerBridgeCallSourceParams = Readonly<{
  /** Key used in the broker selections env map. */
  selectionKey: string;
  /** Daemon bridge route for this brokered service. */
  bridgePath: string;
  /** Connected service id sent in the bridge selection body. */
  serviceId: string;
  /** Optional request-body field that should receive `selection.planType`. */
  planTypeBodyKey?: string | null;
  /** Result keys to scan for a stable account id before falling back to `selection.accountId`. */
  resultAccountIdKeys?: readonly string[];
  /** Env var holding the JSON map of brokered selection keys → selection identity. */
  selectionsEnv: string;
  /** Env var holding the absolute path to the daemon-state file (`httpPort` is read at call time). */
  daemonStatePathEnv: string;
  /** Env var holding the SCOPED broker-refresh capability token (NEVER the master control token). */
  refreshTokenEnv: string;
  /** Env var holding the broker version (for the bridge sessionId only). */
  pluginVersionEnv: string;
  /** Fallback broker version literal (when the env var is unset). */
  pluginVersion: string;
  /** Stable tag for the synthetic bridge `sessionId`. */
  sessionTag: string;
  /**
   * R3-6: env var holding the baked broker SELECTION IDENTITY string. The synthetic `sessionId`
   * can never authorize against tracked sessions; the identity is the broker's genuine stable
   * identity, and the daemon authorizes it against a LIVE runtime target carrying the same value.
   * Omitted (or unset at call time) → the body field is omitted.
   */
  selectionIdentityEnv?: string | null;
}>;

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the shared bridge-call JS for one brokered selection, parameterized by the owning broker's
 * descriptor so concrete provider/service facts do not live in the SDK.
 */
export function buildBrokerBridgeCallSource(params: BrokerBridgeCallSourceParams): string {
  const resultAccountIdKeys = params.resultAccountIdKeys?.length
    ? params.resultAccountIdKeys
    : ['accountId'];
  return `const SELECTION_KEY = ${jsString(params.selectionKey)};
const BRIDGE_PATH = ${jsString(params.bridgePath)};
const BRIDGE_FETCH_TIMEOUT_MS = 30000;
const SERVICE_ID = ${jsString(params.serviceId)};
const PLAN_TYPE_BODY_KEY = ${JSON.stringify(params.planTypeBodyKey || null)};
const RESULT_ACCOUNT_ID_KEYS = ${JSON.stringify(resultAccountIdKeys)};
const SELECTIONS_ENV = ${jsString(params.selectionsEnv)};
const DAEMON_STATE_PATH_ENV = ${jsString(params.daemonStatePathEnv)};
const REFRESH_TOKEN_ENV = ${jsString(params.refreshTokenEnv)};
const PLUGIN_VERSION_ENV = ${jsString(params.pluginVersionEnv)};
const PLUGIN_VERSION = ${jsString(params.pluginVersion)};
const SESSION_TAG = ${jsString(params.sessionTag)};
const BRIDGE_SELECTION_IDENTITY_ENV = ${params.selectionIdentityEnv ? jsString(params.selectionIdentityEnv) : 'null'};

function readJsonEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Read ONLY the daemon HTTP port from the 0600 state file. The broker deliberately does NOT read the
// master controlToken (least privilege): it authenticates with the SCOPED broker-refresh token from
// its env, so even reading the state file cannot grant it the broad control surface.
function readDaemonHttpPort() {
  const path = process.env[DAEMON_STATE_PATH_ENV];
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("happier_broker_daemon_state_path_missing");
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw new Error("happier_broker_daemon_state_unreadable");
  }
  const httpPort = parsed && typeof parsed.httpPort === "number" ? parsed.httpPort : null;
  if (!httpPort) throw new Error("happier_broker_daemon_state_incomplete");
  return httpPort;
}

// The scoped broker-refresh capability token (NOT the master controlToken), injected via env.
function readScopedToken() {
  const token = process.env[REFRESH_TOKEN_ENV];
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("happier_broker_scoped_token_missing");
  }
  return token.trim();
}

function resolveSelection() {
  const selections = readJsonEnv(SELECTIONS_ENV) || {};
  const selection = selections[SELECTION_KEY];
  if (!selection || typeof selection.profileId !== "string" || selection.profileId.length === 0) {
    throw new Error("happier_broker_selection_missing");
  }
  return selection;
}

// R3-6: the baked selection-identity string is the broker's genuine stable identity for daemon-side
// authorization (the sessionId below is synthetic). Absent env → null (field omitted from the body).
function readSelectionIdentity() {
  if (!BRIDGE_SELECTION_IDENTITY_ENV) return null;
  const raw = process.env[BRIDGE_SELECTION_IDENTITY_ENV];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

// Calls the Happier daemon bridge for an ACCESS token. The daemon returns the CURRENT access token
// when it is still valid and rotates ONLY when near-expiry or when forceRefresh is set (the 401-retry
// path). Returns { accessToken, accountId, expiresAt }.
async function fetchAccessTokenFromBridge(forceRefresh) {
  const httpPort = readDaemonHttpPort();
  const scopedToken = readScopedToken();
  const selection = resolveSelection();
  const body = {
    sessionId: SESSION_TAG + ":" + SELECTION_KEY + ":" + (process.env[PLUGIN_VERSION_ENV] || PLUGIN_VERSION),
    selection: { kind: "profile", serviceId: SERVICE_ID, profileId: selection.profileId },
    forceRefresh: forceRefresh === true,
  };
  if (PLAN_TYPE_BODY_KEY) body[PLAN_TYPE_BODY_KEY] = selection.planType || null;
  const selectionIdentity = readSelectionIdentity();
  if (selectionIdentity) body.selectionIdentity = selectionIdentity;
  // RR-7: a hung daemon must not hang the provider's auth path forever — bound the bridge call.
  // Guarded like the daemon's own OAuth fetch (AbortSignal.timeout needs node >= 17.3 / Bun).
  const bridgeAbort = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? { signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS) }
    : {};
  const response = await fetch("http://127.0.0.1:" + httpPort + BRIDGE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-happier-daemon-token": scopedToken },
    body: JSON.stringify(body),
    ...bridgeAbort,
  });
  if (!response.ok) {
    throw new Error("happier_broker_bridge_status_" + response.status);
  }
  const json = await response.json().catch(() => null);
  const result = json && json.result ? json.result : null;
  const accessToken = result && typeof result.accessToken === "string" ? result.accessToken : "";
  if (!accessToken) throw new Error("happier_broker_bridge_no_access_token");
  let accountId = selection.accountId || null;
  if (result) {
    for (const key of RESULT_ACCOUNT_ID_KEYS) {
      if (typeof key === "string" && typeof result[key] === "string" && result[key]) {
        accountId = result[key];
        break;
      }
    }
  }
  const expiresAt = result && typeof result.expiresAt === "number" ? result.expiresAt : null;
  return { accessToken: accessToken, accountId: accountId, expiresAt: expiresAt };
}`;
}
