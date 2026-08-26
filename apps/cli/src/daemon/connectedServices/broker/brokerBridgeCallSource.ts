import {
  CONNECTED_SERVICE_RUNTIME_AUTH_RECOVERY_TRANSPORT_TIMEOUT_MS,
} from '@/daemon/connectedServices/runtimeAuth/connectedServiceRuntimeAuthTimeouts';

/**
 * Shared, provider-agnostic bridge-call source for connected-service auth brokers.
 *
 * The OpenCode broker plugin (Bun runtime) and the Pi broker extension (jiti runtime) both need the
 * IDENTICAL daemon-bridge call: read the daemon HTTP port and its matching SCOPED broker-refresh
 * capability token from one 0600 broker-state snapshot, resolve the brokered selection, and
 * POST to the shared daemon bridge to obtain a fresh ACCESS token (the daemon is the sole refresher;
 * NO refresh token is ever present in the runtime).
 *
 * Factoring this into one stringified builder keeps the two runtime artifacts in lockstep (a wire-shape
 * change touches a single place) without forcing a shared plugin API (OpenCode's plugin API and Pi's
 * extension API differ; only the bridge CALL is common).
 *
 * The emitted source is self-contained ESM-statement JS that imports only `node:fs` `readFileSync` and
 * uses `fetch`/`process` globals. It defines:
 *   - `fetchAccessTokenFromBridge(forceRefresh)` → `{ accessToken, accountId, expiresAt }`
 *   - `readCurrentBrokerEndpoint()` (also used by a broker's load handshake)
 * Callers must place `import { createHash } from "node:crypto";` and
 * `import { readFileSync } from "node:fs";` at the top of the assembled module.
 */

/**
 * Load-handshake path: a broker pings this once on activation so the daemon can record that the
 * runtime artifact actually loaded. Shared across brokers (the daemon registry is keyed by the stable
 * selection identity, not by provider).
 */
export const CONNECTED_SERVICE_BROKER_LOADED_HANDSHAKE_PATH =
  '/connected-service-auth/broker/loaded';

/**
 * The broker waits for the complete daemon-owned auth operation, which can include one bounded
 * server profile-health lookup plus token rotation and optional provider evidence. Keep this outer
 * budget above those inner waits so a slow-but-valid result is not abandoned and retried while the
 * daemon is still completing the original request.
 */
export const CONNECTED_SERVICE_BROKER_BRIDGE_FETCH_TIMEOUT_MS =
  CONNECTED_SERVICE_RUNTIME_AUTH_RECOVERY_TRANSPORT_TIMEOUT_MS;

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the shared bridge-call JS for one provider.
 */
export function buildBrokerBridgeCallSource(params: Readonly<{
  /** Stable broker selection tag used to read this provider's entry from the selections env. */
  providerTag: string;
  /** Daemon bridge path this provider-owned broker caller should POST to. */
  bridgePath: string;
  /** Connected-service id to send inside the bridge selection body. */
  serviceId: string;
  /** Env var holding the JSON map of brokered providers → selection identity. */
  selectionsEnv: string;
  /** Env var holding the absolute path to the minimal broker-state file (read at call time). */
  brokerStatePathEnv: string;
  /** Env var holding the broker version (for the bridge sessionId only). */
  pluginVersionEnv: string;
  /** Fallback broker version literal (when the env var is unset). */
  pluginVersion: string;
  /** Stable tag for the synthetic bridge `sessionId` (e.g. `opencode-broker` / `pi-broker`). */
  sessionTag: string;
  /** Env var holding the stable broker selection identity used for daemon-side effective selection. */
  selectionIdentityEnv?: string | null;
  /** Optional request body field used by providers whose bridge accepts a plan hint. */
  planTypeBodyField?: string | null;
  /** Response fields to check, in order, for a provider account id. */
  accountIdResultFields?: readonly string[];
}>): string {
  const accountIdResultFields = params.accountIdResultFields ?? ['accountId'];
  return `const PROVIDER = ${jsString(params.providerTag)};
const BRIDGE_PATH = ${jsString(params.bridgePath)};
const BRIDGE_FETCH_TIMEOUT_MS = ${CONNECTED_SERVICE_BROKER_BRIDGE_FETCH_TIMEOUT_MS};
const SERVICE_ID = ${jsString(params.serviceId)};
const SELECTIONS_ENV = ${jsString(params.selectionsEnv)};
const BROKER_STATE_PATH_ENV = ${jsString(params.brokerStatePathEnv)};
const PLUGIN_VERSION_ENV = ${jsString(params.pluginVersionEnv)};
const PLUGIN_VERSION = ${jsString(params.pluginVersion)};
const SESSION_TAG = ${jsString(params.sessionTag)};
const BRIDGE_SELECTION_IDENTITY_ENV = ${params.selectionIdentityEnv ? jsString(params.selectionIdentityEnv) : 'null'};
const PLAN_TYPE_BODY_FIELD = ${params.planTypeBodyField ? jsString(params.planTypeBodyField) : 'null'};
const ACCOUNT_ID_RESULT_FIELDS = ${JSON.stringify(accountIdResultFields)};

function readJsonEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Read the current daemon endpoint and its matching scoped capability from ONE atomic broker snapshot.
// This lets a surviving broker follow daemon replacement without combining the replacement port with
// a stale spawn-time token. The descriptor never contains the broad daemon control token.
function readCurrentBrokerEndpoint() {
  const path = process.env[BROKER_STATE_PATH_ENV];
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("happier_broker_state_path_missing");
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw new Error("happier_broker_state_unreadable");
  }
  const httpPort = parsed
    && typeof parsed.httpPort === "number"
    && Number.isInteger(parsed.httpPort)
    && parsed.httpPort > 0
    && parsed.httpPort <= 65535
    ? parsed.httpPort
    : null;
  const scopedToken = parsed && typeof parsed.connectedServiceBrokerRefreshToken === "string"
    ? parsed.connectedServiceBrokerRefreshToken.trim()
    : "";
  if (httpPort === null || !scopedToken) throw new Error("happier_broker_state_incomplete");
  return { httpPort: httpPort, scopedToken: scopedToken };
}

function resolveSelection() {
  const selections = readJsonEnv(SELECTIONS_ENV) || {};
  const selection = selections[PROVIDER];
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new Error("happier_broker_selection_missing");
  }
  if (selection.kind === "group") {
    if (
      selection.serviceId !== SERVICE_ID
      || typeof selection.groupId !== "string"
      || selection.groupId.length === 0
      || typeof selection.activeProfileId !== "string"
      || selection.activeProfileId.length === 0
      || typeof selection.fallbackProfileId !== "string"
      || selection.fallbackProfileId.length === 0
      || typeof selection.generation !== "number"
    ) {
      throw new Error("happier_broker_selection_missing");
    }
    return {
      kind: "group",
      serviceId: SERVICE_ID,
      groupId: selection.groupId,
      activeProfileId: selection.activeProfileId,
      fallbackProfileId: selection.fallbackProfileId,
      generation: selection.generation,
      accountId: selection.accountId || null,
      planType: selection.planType || null,
    };
  }
  if (typeof selection.profileId !== "string" || selection.profileId.length === 0) {
    throw new Error("happier_broker_selection_missing");
  }
  if (selection.serviceId && selection.serviceId !== SERVICE_ID) {
    throw new Error("happier_broker_selection_missing");
  }
  return selection;
}

function readSelectionIdentity() {
  if (!BRIDGE_SELECTION_IDENTITY_ENV) return null;
  const identity = process.env[BRIDGE_SELECTION_IDENTITY_ENV];
  return typeof identity === "string" && identity.trim().length > 0 ? identity.trim() : null;
}

function computeAccessTokenFingerprint(accessToken) {
  return "sha256:" + createHash("sha256").update(String(accessToken)).digest("hex").slice(0, 8);
}

function buildBridgeSelection(selection) {
  if (selection && selection.kind === "group") {
    return {
      kind: "group",
      serviceId: SERVICE_ID,
      groupId: selection.groupId,
      activeProfileId: selection.activeProfileId,
      fallbackProfileId: selection.fallbackProfileId,
      generation: selection.generation,
    };
  }
  return { kind: "profile", serviceId: SERVICE_ID, profileId: selection.profileId };
}

// Calls the Happier daemon bridge for an ACCESS token. The daemon returns the CURRENT access token
// when it is still valid and rotates ONLY when near-expiry or when forceRefresh is set (the 401-retry
// path). Returns { accessToken, accountId, expiresAt }.
async function fetchAccessTokenFromBridge(forceRefresh, failingAccessToken) {
  const daemonEndpoint = readCurrentBrokerEndpoint();
  const selection = resolveSelection();
  const body = {
    sessionId: SESSION_TAG + ":" + PROVIDER + ":" + (process.env[PLUGIN_VERSION_ENV] || PLUGIN_VERSION),
    selection: buildBridgeSelection(selection),
    forceRefresh: forceRefresh === true,
  };
  const selectionIdentity = readSelectionIdentity();
  if (selectionIdentity) body.selectionIdentity = selectionIdentity;
  if (PLAN_TYPE_BODY_FIELD) body[PLAN_TYPE_BODY_FIELD] = selection.planType || null;
  if (forceRefresh === true && typeof failingAccessToken === "string" && failingAccessToken.length > 0) {
    body.failingAccessTokenFingerprint = computeAccessTokenFingerprint(failingAccessToken);
  }
  // RR-7: a hung daemon must not hang the provider's auth path forever — bound the bridge call.
  // Guarded like the daemon's own OAuth fetch (AbortSignal.timeout needs node >= 17.3 / Bun).
  const bridgeAbort = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? { signal: AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS) }
    : {};
  const response = await fetch("http://127.0.0.1:" + daemonEndpoint.httpPort + BRIDGE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-happier-daemon-token": daemonEndpoint.scopedToken },
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
    for (const field of ACCOUNT_ID_RESULT_FIELDS) {
      if (typeof result[field] === "string" && result[field].length > 0) {
        accountId = result[field];
        break;
      }
    }
  }
  const expiresAt = result && typeof result.expiresAt === "number" ? result.expiresAt : null;
  const selectionEpoch = result && typeof result.selectionEpoch === "number" ? result.selectionEpoch : null;
  return { accessToken: accessToken, accountId: accountId, expiresAt: expiresAt, selectionEpoch: selectionEpoch };
}`;
}
