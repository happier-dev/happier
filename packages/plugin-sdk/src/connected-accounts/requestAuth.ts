import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER, CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION, CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1, CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH, CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH, CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH, CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH } from '@happier-dev/protocol/connect/connected-account-request-auth';
import type { ConnectedAccountAuthFailureRequestV1, ConnectedAccountQuotaFailureRequestV1, RequestAuthHeadersV1, QualifiedConnectedAccountPurposeV1, RequestAuthFailureOutcomeV1 } from '@happier-dev/protocol';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';

export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV =
  'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH' as const;

export type ConnectedAccountRequestAuthClientSourceParams = Readonly<{
  /** Env var containing the private, atomically rotated request-auth endpoint/capability document. */
  capabilityPathEnv: string;
  /** Host callers carry the private path directly without putting it into ambient environment. */
  capabilityPath?: string;
  requestTimeoutMs?: number;
  /** Authentication recovery may rotate an OAuth credential and fetch provider evidence, so it has a larger bounded wait. */
  authFailureRequestTimeoutMs?: number;
}>;

function js(value: unknown): string {
  return JSON.stringify(value);
}

function validateEnvName(value: string, field: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(value)) {
    throw new Error(`Invalid request-auth ${field} environment variable name`);
  }
  return value;
}

/**
 * Emits a self-contained, transport-only ESM source fragment.
 *
 * The assembled module supplies `readFileSync` from `node:fs`. The fragment owns no selection,
 * refresh, quota, retry, or caching decision. It rereads the scoped capability file for every call.
 */
export function buildConnectedAccountRequestAuthClientSource(
  input: ConnectedAccountRequestAuthClientSourceParams,
): string {
  const capabilityPathEnv = validateEnvName(input.capabilityPathEnv, 'capability-path');
  const requestTimeoutMs = input.requestTimeoutMs;
  if (requestTimeoutMs !== undefined
    && (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000)) {
    throw new Error('Invalid request-auth timeout');
  }
  // The host recovery owner allows 300 seconds for the provider-owned refresh/evidence
  // sequence. Keep the recovery transport just above that owner. Ordinary
  // requests inherit caller cancellation unless an explicit budget is supplied.
  const authFailureRequestTimeoutMs = input.authFailureRequestTimeoutMs ?? 310_000;
  if (
    !Number.isSafeInteger(authFailureRequestTimeoutMs)
    || authFailureRequestTimeoutMs < 1
    || authFailureRequestTimeoutMs > 600_000
  ) {
    throw new Error('Invalid request-auth recovery timeout');
  }

  return `const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV = ${js(capabilityPathEnv)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER = ${js(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH = ${js(CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH = ${js(CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH = ${js(CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_TIMEOUT_MS = ${requestTimeoutMs};
const CONNECTED_ACCOUNT_REQUEST_AUTH_RECOVERY_TIMEOUT_MS = ${authFailureRequestTimeoutMs};
const CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS = Object.freeze(${js(CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS_V1)});

class ConnectedAccountRequestAuthTransportError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "ConnectedAccountRequestAuthTransportError";
    this.code = code;
    this.status = status;
  }
}

function requestAuthIsRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestAuthHasExactKeys(value, required, optional) {
  if (!requestAuthIsRecord(value)) return false;
  const allowed = new Set(required.concat(optional || []));
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function requestAuthIsBoundedString(value, min, max) {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function requestAuthUtf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function requestAuthIsPluginId(value) {
  if (!requestAuthIsBoundedString(value, 3, 256) || value !== value.trim()) return false;
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\\\") || value.startsWith(".") || value.endsWith(".")) return false;
  const parts = value.split(".");
  return parts.length >= 2 && parts.every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))
    && !parts.some((part) => part === "__proto__" || part === "constructor" || part === "prototype");
}

function requestAuthParseContributionIdentity(value) {
  if (!requestAuthHasExactKeys(value, ["pluginId", "localId"])) throw new Error("happier_request_auth_schema_invalid");
  if (!requestAuthIsPluginId(value.pluginId) || !/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(value.localId)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  return { pluginId: value.pluginId, localId: value.localId };
}

function requestAuthParsePurpose(value) {
  if (!requestAuthHasExactKeys(value, ["consumer", "purpose"])) throw new Error("happier_request_auth_schema_invalid");
  if (!requestAuthIsBoundedString(value.purpose, 1, 128) || value.purpose !== value.purpose.trim()) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  return { consumer: requestAuthParseContributionIdentity(value.consumer), purpose: value.purpose };
}

function requestAuthParseAccount(value) {
  if (!requestAuthHasExactKeys(value, ["service", "accountId"])) throw new Error("happier_request_auth_schema_invalid");
  if (!requestAuthIsBoundedString(value.accountId, 1, 256) || value.accountId !== value.accountId.trim()) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const service = requestAuthHasExactKeys(value.service, ["pluginId", "localId"])
    && value.service.pluginId === ${js(HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1.pluginId)}
    && value.service.localId === ${js(HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1.localId)}
    ? { pluginId: value.service.pluginId, localId: value.service.localId }
    : requestAuthParseContributionIdentity(value.service);
  return { service, accountId: value.accountId };
}

function requestAuthParseCredentialContext(value) {
  if (!requestAuthHasExactKeys(value, ["account", "credentialRevision"], ["group", "failingAccessTokenFingerprint"])) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  if (typeof value.credentialRevision !== "string" || !/^csr_[A-Za-z0-9_-]{22,64}$/.test(value.credentialRevision)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  let group;
  if (value.group !== undefined) {
    if (!requestAuthHasExactKeys(value.group, ["groupId", "generation"])
      || typeof value.group.groupId !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.group.groupId)
      || !Number.isSafeInteger(value.group.generation)
      || value.group.generation < 0) {
      throw new Error("happier_request_auth_schema_invalid");
    }
    group = { groupId: value.group.groupId, generation: value.group.generation };
  }
  if (value.failingAccessTokenFingerprint !== undefined
    && (typeof value.failingAccessTokenFingerprint !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(value.failingAccessTokenFingerprint))) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  return {
    account: requestAuthParseAccount(value.account),
    ...(group ? { group } : {}),
    credentialRevision: value.credentialRevision,
    ...(value.failingAccessTokenFingerprint !== undefined
      ? { failingAccessTokenFingerprint: value.failingAccessTokenFingerprint }
      : {}),
  };
}

function requestAuthParseEvidence(value) {
  if (!requestAuthHasExactKeys(
    value,
    ["limitCategory", "quotaScope", "evidenceSource"],
    ["httpStatus", "providerCode", "retryAfterMs", "resetAtMs"],
  )) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  if (![
    "usage_limit",
    "rate_limit",
    "capacity",
    "temporary_throttle",
    "auth_invalid",
    "plan_invalid",
    "validation_failed",
    "disabled",
    "unknown",
  ].includes(value.limitCategory)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  if (![
    "account",
    "workspace",
    "organization",
    "project",
    "model",
    "provider",
    "unknown",
  ].includes(value.quotaScope)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  let evidenceSource;
  if (requestAuthHasExactKeys(value.evidenceSource, ["kind"])
    && value.evidenceSource.kind === "structured") {
    evidenceSource = { kind: "structured" };
  } else {
    throw new Error("happier_request_auth_schema_invalid");
  }
  if (value.httpStatus !== undefined && (!Number.isSafeInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  if (value.providerCode !== undefined
    && (!requestAuthIsBoundedString(value.providerCode, 1, 128) || value.providerCode !== value.providerCode.trim())) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  if (value.retryAfterMs !== undefined
    && (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0 || value.retryAfterMs > 604800000)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  if (value.resetAtMs !== undefined && (!Number.isSafeInteger(value.resetAtMs) || value.resetAtMs < 0)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  return {
    ...value,
    evidenceSource,
  };
}

function requestAuthParseFailure(value, expectedClass) {
  const scoped = expectedClass === "insufficient_scope";
  if (!requestAuthHasExactKeys(value, scoped ? ["class", "evidence", "requiredScopes"] : ["class", "evidence"]) || value.class !== expectedClass) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const evidence = requestAuthParseEvidence(value.evidence);
  if (
    (expectedClass === "authentication" && evidence.limitCategory !== "auth_invalid")
    || (expectedClass === "quota" && evidence.limitCategory === "auth_invalid")
  ) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  if (scoped) {
    if (evidence.limitCategory !== "validation_failed" || !Array.isArray(value.requiredScopes)
      || !value.requiredScopes.every((scope) => typeof scope === "string" && scope.length > 0)) {
      throw new Error("happier_request_auth_schema_invalid");
    }
    return { class: expectedClass, evidence, requiredScopes: [...value.requiredScopes] };
  }
  return { class: expectedClass, evidence };
}

function requestAuthParseMaterial(value) {
  if (!requestAuthHasExactKeys(value, ["headers", "facts", "credentialContext"], ["expiresAt"])
    || !requestAuthIsRecord(value.headers) || Object.keys(value.headers).length > 32
    || !requestAuthIsRecord(value.facts)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const headers = {};
  const seen = new Set();
  for (const [name, headerValue] of Object.entries(value.headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+\\-.^_\`|~0-9A-Za-z]{1,128}$/.test(name)
      || seen.has(lower) || typeof headerValue !== "string"
      || (headerValue.length > (lower === "authorization" ? 131079 : 16384)) || /[\\r\\n]/.test(headerValue)) {
      throw new Error("happier_request_auth_schema_invalid");
    }
    seen.add(lower);
    Object.defineProperty(headers, name, { value: headerValue, enumerable: true });
  }
  const facts = {};
  for (const [name, fact] of Object.entries(value.facts)) {
    if (typeof fact !== "string" && typeof fact !== "boolean"
      && (typeof fact !== "number" || !Number.isFinite(fact))) {
      throw new Error("happier_request_auth_schema_invalid");
    }
    Object.defineProperty(facts, name, { value: fact, enumerable: true });
  }
  if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  return { headers, facts,
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
    credentialContext: requestAuthParseCredentialContext(value.credentialContext),
  };
}

function requestAuthParseOutcome(value) {
  if (!requestAuthHasExactKeys(value, ["status"])
    || !["stale_context", "current_unchanged", "current_changed", "denied"].includes(value.status)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  return { status: value.status };
}

// Deliberately reread one atomically replaced tuple for every independent operation.
function requestAuthReadTransportTuple() {
  const path = ${input.capabilityPath === undefined ? 'process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]' : js(input.capabilityPath)};
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("happier_request_auth_capability_path_missing");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.trim(), "utf8"));
  } catch {
    throw new Error("happier_request_auth_capability_file_unreadable");
  }
  if (!requestAuthHasExactKeys(parsed, ["v", "materializationId", "subjectScopeDigest", "capability", "httpPort"])
    || parsed.v !== ${CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION}
    || typeof parsed.materializationId !== "string"
    || parsed.materializationId.length === 0
    || parsed.materializationId !== parsed.materializationId.trim()
    || requestAuthUtf8ByteLength(parsed.materializationId)
      > ${CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH}
    || typeof parsed.subjectScopeDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(parsed.subjectScopeDigest)
    || typeof parsed.capability !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(parsed.capability)
    || !Number.isSafeInteger(parsed.httpPort)
    || parsed.httpPort < 1
    || parsed.httpPort > 65535) {
    throw new Error("happier_request_auth_capability_file_invalid");
  }
  return {
    capability: parsed.capability,
    httpPort: parsed.httpPort,
  };
}

function requestAuthComposeSignal(signal, timeoutMs) {
  const timeout = timeoutMs !== undefined && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(timeoutMs)
    : null;
  if (signal && timeout && typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return signal || timeout || undefined;
}

async function requestAuthReadResponse(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    return { kind: "decoded", envelope: null };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch {
        return { kind: "read_failed", envelope: null };
      }
      if (result.done) break;
      byteLength += result.value.byteLength;
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const encoded = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      kind: "decoded",
      envelope: JSON.parse(new TextDecoder().decode(encoded)),
    };
  } catch {
    return { kind: "decoded", envelope: null };
  }
}

async function requestAuthCall(path, body, signal, timeoutMs = CONNECTED_ACCOUNT_REQUEST_AUTH_TIMEOUT_MS) {
  const transport = requestAuthReadTransportTuple();
  let response;
  try {
    response = await fetch("http://127.0.0.1:" + transport.httpPort + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER]: transport.capability,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: requestAuthComposeSignal(signal, timeoutMs),
    });
  } catch (error) {
    if (signal && signal.aborted) throw error;
    throw new ConnectedAccountRequestAuthTransportError("request_auth_unavailable", 503);
  }
  const decoded = await requestAuthReadResponse(response);
  if (decoded.kind === "read_failed") {
    throw new ConnectedAccountRequestAuthTransportError(
      "happier_request_auth_response_read_failed",
      response.status,
    );
  }
  const envelope = decoded.envelope;
  if (response.status === 200) {
    if (!requestAuthHasExactKeys(envelope, ["ok", "value"]) || envelope.ok !== true) {
      throw new ConnectedAccountRequestAuthTransportError("happier_request_auth_response_invalid", response.status);
    }
    return envelope.value;
  }
  const code = requestAuthHasExactKeys(envelope, ["ok", "error"])
    && envelope.ok === false
    && requestAuthHasExactKeys(envelope.error, ["code"])
    && requestAuthIsBoundedString(envelope.error.code, 1, 128)
    ? envelope.error.code
    : null;
  if (code === null || CONNECTED_ACCOUNT_REQUEST_AUTH_ERROR_HTTP_STATUS[code] !== response.status) {
    throw new ConnectedAccountRequestAuthTransportError("happier_request_auth_response_invalid", response.status);
  }
  if (code === "request_auth_unauthorized") {
    // A valid 401 means this single capability tuple is no longer usable. Keep
    // the provider-facing result retry-safe without rereading or replaying the
    // request; the next explicit call will observe the atomically rotated tuple.
    throw new ConnectedAccountRequestAuthTransportError("request_auth_unavailable", 503);
  }
  throw new ConnectedAccountRequestAuthTransportError(code, response.status);
}

async function lookupConnectedAccountRequestAuth(input) {
  if (!requestAuthHasExactKeys(input, ["purpose"], ["signal"])) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const purpose = requestAuthParsePurpose(input.purpose);
  return requestAuthParseMaterial(await requestAuthCall(
    CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
    { purpose },
    input.signal,
  ));
}

async function reportConnectedAccountAuthFailure(input) {
  if (!requestAuthHasExactKeys(input, ["credentialContext", "normalizedFailure"], ["signal"])) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const failureClass = input.normalizedFailure?.class;
  if (failureClass !== "authentication" && failureClass !== "insufficient_scope") throw new Error("happier_request_auth_schema_invalid");
  const body = {
    credentialContext: requestAuthParseCredentialContext(input.credentialContext),
    normalizedFailure: requestAuthParseFailure(input.normalizedFailure, failureClass),
  };
  return requestAuthParseOutcome(await requestAuthCall(
    CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
    body,
    input.signal,
    CONNECTED_ACCOUNT_REQUEST_AUTH_RECOVERY_TIMEOUT_MS,
  ));
}

async function reportConnectedAccountQuotaFailure(input) {
  if (!requestAuthHasExactKeys(input, ["credentialContext", "normalizedFailure"], ["signal"])) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const body = {
    credentialContext: requestAuthParseCredentialContext(input.credentialContext),
    normalizedFailure: requestAuthParseFailure(input.normalizedFailure, "quota"),
  };
  return requestAuthParseOutcome(await requestAuthCall(
    CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
    body,
    input.signal,
  ));
}

`;
}

export type ConnectedAccountRequestAuthClient = Readonly<{
  lookupConnectedAccountRequestAuth(input: Readonly<{ purpose: QualifiedConnectedAccountPurposeV1; signal?: AbortSignal }>): Promise<RequestAuthHeadersV1>;
  reportConnectedAccountAuthFailure(input: ConnectedAccountAuthFailureRequestV1 & Readonly<{ signal?: AbortSignal }>): Promise<RequestAuthFailureOutcomeV1>;
  reportConnectedAccountQuotaFailure(input: ConnectedAccountQuotaFailureRequestV1 & Readonly<{ signal?: AbortSignal }>): Promise<RequestAuthFailureOutcomeV1>;
}>;

