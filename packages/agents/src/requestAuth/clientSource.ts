import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH,
  PI_REQUEST_AUTH_PINNED_TERMINAL_PRODUCER_VERSIONS_V1,
  PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURES_V1,
} from '@happier-dev/protocol/connect/connected-account-request-auth';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH,
} from './capabilityFile.js';

export const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER =
  'x-happier-connected-account-capability' as const;

export type ConnectedAccountRequestAuthClientSourceParams = Readonly<{
  /** Env var containing the private, atomically rotated request-auth endpoint/capability document. */
  capabilityPathEnv: string;
  requestTimeoutMs?: number;
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
  const requestTimeoutMs = input.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new Error('Invalid request-auth timeout');
  }

  return `const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV = ${js(capabilityPathEnv)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER = ${js(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH = ${js(CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH = ${js(CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH = ${js(CONNECTED_ACCOUNT_REQUEST_AUTH_QUOTA_FAILURE_PATH)};
const CONNECTED_ACCOUNT_REQUEST_AUTH_TIMEOUT_MS = ${requestTimeoutMs};
const CONNECTED_ACCOUNT_REQUEST_AUTH_RESPONSE_MAX_BYTES = 256 * 1024;
const CONNECTED_ACCOUNT_REQUEST_AUTH_PINNED_TERMINAL_FRONTIER = Object.freeze({
  producerVersions: Object.freeze(${js(PI_REQUEST_AUTH_PINNED_TERMINAL_PRODUCER_VERSIONS_V1)}),
  signatures: Object.freeze(${js(PI_REQUEST_AUTH_PINNED_TERMINAL_SIGNATURES_V1)}),
});

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
  return { service: requestAuthParseContributionIdentity(value.service), accountId: value.accountId };
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
  } else if (
    requestAuthHasExactKeys(
      value.evidenceSource,
      ["kind", "producer", "producerVersion", "provider", "signatureId"],
    )
    && value.evidenceSource.kind === "pinnedProviderTerminal"
    && value.evidenceSource.producer === "pi"
    && requestAuthIsBoundedString(value.evidenceSource.producerVersion, 1, 64)
    && value.evidenceSource.producerVersion === value.evidenceSource.producerVersion.trim()
    && requestAuthIsBoundedString(value.evidenceSource.provider, 1, 128)
    && value.evidenceSource.provider === value.evidenceSource.provider.trim()
    && requestAuthIsBoundedString(value.evidenceSource.signatureId, 1, 128)
    && value.evidenceSource.signatureId === value.evidenceSource.signatureId.trim()
  ) {
    evidenceSource = { ...value.evidenceSource };
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
  if (evidenceSource.kind === "pinnedProviderTerminal") {
    const signature = CONNECTED_ACCOUNT_REQUEST_AUTH_PINNED_TERMINAL_FRONTIER.signatures.find((candidate) => (
      candidate.provider === evidenceSource.provider
      && candidate.signatureId === evidenceSource.signatureId
    ));
    if (
      !CONNECTED_ACCOUNT_REQUEST_AUTH_PINNED_TERMINAL_FRONTIER.producerVersions.includes(
        evidenceSource.producerVersion,
      )
      || !signature
      || signature.limitCategory !== value.limitCategory
      || signature.quotaScope !== value.quotaScope
      || (value.httpStatus !== undefined && signature.httpStatus !== value.httpStatus)
    ) {
      throw new Error("happier_request_auth_schema_invalid");
    }
  }
  return {
    ...value,
    evidenceSource,
  };
}

function requestAuthParseFailure(value, expectedClass) {
  if (!requestAuthHasExactKeys(value, ["class", "evidence"]) || value.class !== expectedClass) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const evidence = requestAuthParseEvidence(value.evidence);
  if (
    (expectedClass === "authentication" && evidence.limitCategory !== "auth_invalid")
    || (expectedClass === "quota" && evidence.limitCategory === "auth_invalid")
  ) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  return { class: expectedClass, evidence };
}

function requestAuthParseLease(value) {
  if (!requestAuthHasExactKeys(value, ["accessToken", "credentialContext"], ["requiredHeaders", "expiresAt"])
    || !requestAuthIsBoundedString(value.accessToken, 1, 131072)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  let requiredHeaders;
  if (value.requiredHeaders !== undefined) {
    if (!requestAuthIsRecord(value.requiredHeaders) || Object.keys(value.requiredHeaders).length > 32) {
      throw new Error("happier_request_auth_schema_invalid");
    }
    requiredHeaders = {};
    const seen = new Set();
    for (const [name, headerValue] of Object.entries(value.requiredHeaders)) {
      const lower = name.toLowerCase();
      if (!/^[!#$%&'*+\\-.^_\`|~0-9A-Za-z]{1,128}$/.test(name)
        || lower === "authorization"
        || seen.has(lower)
        || typeof headerValue !== "string"
        || headerValue.length > 16384
        || /[\\r\\n]/.test(headerValue)) {
        throw new Error("happier_request_auth_schema_invalid");
      }
      seen.add(lower);
      requiredHeaders[name] = headerValue;
    }
  }
  if (value.expiresAt !== undefined && (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0)) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  return {
    accessToken: value.accessToken,
    ...(requiredHeaders ? { requiredHeaders } : {}),
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
  const path = process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
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
    || parsed.v !== 2
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

function requestAuthComposeSignal(signal) {
  const timeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(CONNECTED_ACCOUNT_REQUEST_AUTH_TIMEOUT_MS)
    : null;
  if (signal && timeout && typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  return signal || timeout || undefined;
}

async function requestAuthReadBoundedResponse(response) {
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
      if (byteLength > CONNECTED_ACCOUNT_REQUEST_AUTH_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: "too_large", envelope: null };
      }
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

async function requestAuthCall(path, body, signal) {
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
      signal: requestAuthComposeSignal(signal),
    });
  } catch (error) {
    if (signal && signal.aborted) throw error;
    throw new ConnectedAccountRequestAuthTransportError("request_auth_unavailable", 503);
  }
  const decoded = await requestAuthReadBoundedResponse(response);
  if (response.status === 401) {
    throw new ConnectedAccountRequestAuthTransportError("request_auth_unavailable", 503);
  }
  if (decoded.kind === "too_large") {
    throw new ConnectedAccountRequestAuthTransportError(
      "happier_request_auth_response_too_large",
      response.status,
    );
  }
  if (decoded.kind === "read_failed") {
    throw new ConnectedAccountRequestAuthTransportError(
      "happier_request_auth_response_read_failed",
      response.status,
    );
  }
  const envelope = decoded.envelope;
  if (!response.ok) {
    const code = requestAuthHasExactKeys(envelope, ["ok", "error"])
      && envelope.ok === false
      && requestAuthHasExactKeys(envelope.error, ["code"])
      && requestAuthIsBoundedString(envelope.error.code, 1, 128)
      ? envelope.error.code
      : "happier_request_auth_status_" + response.status;
    throw new ConnectedAccountRequestAuthTransportError(code, response.status);
  }
  if (!requestAuthHasExactKeys(envelope, ["ok", "value"]) || envelope.ok !== true) {
    throw new ConnectedAccountRequestAuthTransportError("happier_request_auth_response_invalid", response.status);
  }
  return envelope.value;
}

async function lookupConnectedAccountRequestAuth(input) {
  if (!requestAuthHasExactKeys(input, ["purpose"], ["signal"])) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const purpose = requestAuthParsePurpose(input.purpose);
  return requestAuthParseLease(await requestAuthCall(
    CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH,
    { purpose },
    input.signal,
  ));
}

async function reportConnectedAccountAuthFailure(input) {
  if (!requestAuthHasExactKeys(input, ["credentialContext", "normalizedFailure"], ["signal"])) {
    throw new Error("happier_request_auth_schema_invalid");
  }
  const body = {
    credentialContext: requestAuthParseCredentialContext(input.credentialContext),
    normalizedFailure: requestAuthParseFailure(input.normalizedFailure, "authentication"),
  };
  return requestAuthParseOutcome(await requestAuthCall(
    CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH,
    body,
    input.signal,
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
