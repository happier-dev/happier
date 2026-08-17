import { PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { PI_REQUEST_AUTH_PRODUCER_VERSION_ENV } from './env.js';
import {
  PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS,
  PI_REQUEST_AUTH_PROVIDER_OWNED_HEADERS,
} from './purposes.js';

export type PiRequestAuthProviderId = 'anthropic' | 'openai-codex';

export type PiRequestAuthPurposeMap = Readonly<
  Partial<Record<PiRequestAuthProviderId, JsonValue>>
>;

function js(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Assemble the self-contained Pi extension around the shared generated request-auth client.
 *
 * The caller supplies only source emitted by the canonical Connected Accounts transport builder.
 * This leaf owns Pi request shaping, exact response evidence, and the admitted leaf replay budget.
 */
export function buildPiRequestAuthExtensionSource(input: Readonly<{
  purposes: PiRequestAuthPurposeMap;
  requestAuthClientSource: string;
}>): string {
  return `// Happier Pi connected-account request-auth extension (generated).
import { readFileSync } from "node:fs";
// These are Pi extension-runtime imports. Pi's loader provides them from the selected
// @earendil-works/pi-coding-agent installation; they are not Happier plugin dependencies.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

${input.requestAuthClientSource}

const PROVIDER_PURPOSES = Object.freeze(${js(input.purposes)});
const PROVIDER_TARGET_ORIGINS = Object.freeze(${js(Object.fromEntries(
    Object.entries(PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS)
      .map(([providerId, materialization]) => [providerId, materialization.origin]),
  ))});
const PROVIDER_LIMIT_EVIDENCE = Object.freeze(${js(PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1)});
const PRODUCER_VERSION = String(process.env[${js(PI_REQUEST_AUTH_PRODUCER_VERSION_ENV)}] || "");
const REQUEST_AUTH_PLACEHOLDER = "happier-connected-account-request-auth";
const OWNED_HEADERS = Object.freeze(${js(PI_REQUEST_AUTH_PROVIDER_OWNED_HEADERS)});

function mergeAttemptHeaders(providerId, existing, required) {
  const authoritativeNames = new Set([
    ...(OWNED_HEADERS[providerId] || []),
    ...Object.keys(required || {}).map((name) => name.toLowerCase()),
  ]);
  const merged = {};
  for (const [name, value] of Object.entries(existing || {})) {
    if (!authoritativeNames.has(name.toLowerCase())) merged[name] = value;
  }
  for (const [name, value] of Object.entries(required || {})) {
    merged[name] = value;
  }
  return merged;
}

function decodeBase64UrlJson(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function validateCodexAccountHeader(accessToken, requiredHeaders) {
  let projectedAccountId = null;
  for (const [name, value] of Object.entries(requiredHeaders || {})) {
    if (name.toLowerCase() === "chatgpt-account-id") projectedAccountId = value;
  }
  if (projectedAccountId === null) return;
  const payload = decodeBase64UrlJson(String(accessToken).split(".")[1] || "");
  const tokenAccountId = payload
    && payload["https://api.openai.com/auth"]
    && payload["https://api.openai.com/auth"].chatgpt_account_id;
  if (typeof tokenAccountId !== "string" || tokenAccountId !== projectedAccountId) {
    throw new Error("happier_pi_request_auth_codex_account_header_mismatch");
  }
}

function requireProviderTargetOrigin(providerId, model) {
  const expectedOrigin = PROVIDER_TARGET_ORIGINS[providerId];
  const rawBaseUrl = model && typeof model.baseUrl === "string"
    ? model.baseUrl.trim()
    : "";
  let parsed = null;
  try {
    parsed = rawBaseUrl ? new URL(rawBaseUrl) : null;
  } catch {
    parsed = null;
  }
  if (
    !expectedOrigin
    || !parsed
    || parsed.protocol !== "https:"
    || parsed.origin !== expectedOrigin
    || parsed.username
    || parsed.password
    || model.provider !== providerId
  ) {
    throw new Error("happier_pi_request_auth_provider_origin_mismatch:" + providerId);
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function syntheticErrorEvent(model, error, signal) {
  const aborted = signal && signal.aborted;
  const output = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: aborted ? "Request was aborted" : errorText(error),
    timestamp: Date.now(),
  };
  return {
    type: "error",
    reason: output.stopReason,
    error: output,
  };
}

function canRetryAfterOutcome(outcome) {
  return outcome
    && (outcome.status === "stale_context" || outcome.status === "current_changed");
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readProviderTerminalShape(providerId, event) {
  const eventRecord = readRecord(event);
  const error = readRecord(eventRecord && eventRecord.error);
  const errorMessage = error && typeof error.errorMessage === "string"
    ? error.errorMessage.trim()
    : "";
  if (
    !eventRecord
    || eventRecord.type !== "error"
    || eventRecord.reason !== "error"
    || !error
    || error.role !== "assistant"
    || error.provider !== providerId
    || error.stopReason !== "error"
    || !Array.isArray(error.content)
    || error.content.length !== 0
    || !errorMessage
  ) {
    return null;
  }
  return { errorMessage };
}

function isPiReplayTopologyAdmitted() {
  return PROVIDER_LIMIT_EVIDENCE.piTerminalProviderErrors.producerVersions.includes(
    PRODUCER_VERSION,
  );
}

function readPinnedTerminalShape(providerId, event) {
  if (!isPiReplayTopologyAdmitted()) return null;
  return readProviderTerminalShape(providerId, event);
}

function readStructuredTerminalEnvelope(errorMessage) {
  const envelopeMatch = /^([1-5]\\d{2})\\s+(\\{.*\\})$/u.exec(errorMessage);
  if (!envelopeMatch) return null;
  let envelope;
  try {
    envelope = JSON.parse(envelopeMatch[2]);
  } catch {
    return null;
  }
  const envelopeRecord = readRecord(envelope);
  const providerError = readRecord(envelopeRecord && envelopeRecord.error);
  if (
    !envelopeRecord
    || envelopeRecord.type !== "error"
    || !providerError
    || typeof providerError.type !== "string"
    || providerError.type.trim().length === 0
  ) {
    return null;
  }
  return {
    status: Number(envelopeMatch[1]),
    providerError,
  };
}

function parsePinnedTerminalEvidence(providerId, event) {
  const frontier = PROVIDER_LIMIT_EVIDENCE.piTerminalProviderErrors;
  const terminal = readPinnedTerminalShape(providerId, event);
  if (!terminal) return null;
  for (const signature of frontier.signatures) {
    if (signature.provider !== providerId) continue;
    let httpStatus = null;
    if (signature.terminalMessagePattern) {
      if (!(new RegExp(signature.terminalMessagePattern, "u")).test(terminal.errorMessage)) continue;
    } else {
      const envelope = readStructuredTerminalEnvelope(terminal.errorMessage);
      if (
        !envelope
        || envelope.status !== signature.httpStatus
        || envelope.providerError.type !== signature.providerErrorType
        || typeof envelope.providerError.message !== "string"
        || envelope.providerError.message.trim().length === 0
        || (
          signature.messagePattern
          && !(new RegExp(signature.messagePattern, "iu"))
            .test(envelope.providerError.message)
        )
      ) {
        continue;
      }
      httpStatus = envelope.status;
    }
    return {
      category: signature.category,
      quotaScope: signature.quotaScope,
      piRetryable: signature.piRetryable,
      ...(httpStatus === null ? {} : { httpStatus }),
      evidenceSource: {
        kind: "pinnedProviderTerminal",
        producer: "pi",
        producerVersion: PRODUCER_VERSION,
        provider: providerId,
        signatureId: signature.id,
      },
    };
  }
  return null;
}

function parsePinnedTransientTerminal(providerId, event) {
  const frontier = PROVIDER_LIMIT_EVIDENCE.piTerminalProviderErrors;
  const terminal = readPinnedTerminalShape(providerId, event);
  if (!terminal) return null;
  for (const signature of frontier.transientSignatures) {
    if (signature.provider !== providerId) continue;
    if (signature.terminalMessagePattern) {
      if ((new RegExp(signature.terminalMessagePattern, "u")).test(terminal.errorMessage)) {
        return signature;
      }
      continue;
    }
    const envelope = readStructuredTerminalEnvelope(terminal.errorMessage);
    if (
      !envelope
      || !signature.httpStatuses.includes(envelope.status)
      || envelope.providerError.type !== signature.providerErrorType
      || typeof envelope.providerError.message !== "string"
      || !(new RegExp(signature.messagePattern, "u"))
        .test(envelope.providerError.message)
    ) {
      continue;
    }
    return signature;
  }
  return null;
}

function terminalErrorMessage(event) {
  const error = readRecord(readRecord(event) && event.error);
  return error && typeof error.errorMessage === "string" ? error.errorMessage : "";
}

function piAgentSessionWouldRetry(errorMessage) {
  if (!errorMessage) return false;
  const predicate = PROVIDER_LIMIT_EVIDENCE.piTerminalProviderErrors.retryPredicate;
  if (!isPiReplayTopologyAdmitted()) return false;
  const nonRetryable = new RegExp(predicate.nonRetryablePatterns.join("|"), "iu");
  if (nonRetryable.test(errorMessage)) return false;
  const versionPatterns = predicate.retryablePatternsByVersion[PRODUCER_VERSION] || [];
  return new RegExp([...predicate.commonRetryablePatterns, ...versionPatterns].join("|"), "iu")
    .test(errorMessage);
}

function isPiObservedResponseRetryableStatus(status) {
  const frontier = PROVIDER_LIMIT_EVIDENCE.piTerminalProviderErrors;
  return isPiReplayTopologyAdmitted()
    && frontier.retryPredicate.retryableHttpStatuses.includes(status);
}

function withProviderDiagnostic(event) {
  const record = readRecord(event);
  const error = readRecord(record && record.error);
  if (!record || !error) return event;
  const providerDiagnostic = terminalErrorMessage(event);
  return {
    ...record,
    error: {
      ...error,
      ...(providerDiagnostic
        ? { happierRequestAuthProviderDiagnostic: providerDiagnostic }
        : {}),
    },
  };
}

function withoutPiAgentSessionReplay(event) {
  const retained = withProviderDiagnostic(event);
  const record = readRecord(retained);
  const error = readRecord(record && record.error);
  if (!record || !error) return retained;
  return {
    ...record,
    error: {
      ...error,
      errorMessage: "Provider request failed without a safe automatic continuation.",
    },
  };
}

function classifyStructuredResponseStatus(status) {
  if (status === null) return null;
  for (const rule of PROVIDER_LIMIT_EVIDENCE.structuredResponseStatuses) {
    if (
      (Array.isArray(rule.statuses) && rule.statuses.includes(status))
      || (
        rule.range
        && status >= rule.range.min
        && status <= rule.range.max
      )
    ) {
      return {
        category: rule.category,
        quotaScope: rule.quotaScope,
        evidenceSource: { kind: "structured" },
      };
    }
  }
  return null;
}

function classifyStructuredProviderCode(providerCode) {
  const normalized = typeof providerCode === "string"
    ? providerCode.trim().toLowerCase()
    : "";
  if (!normalized) return null;
  for (const rule of PROVIDER_LIMIT_EVIDENCE.structuredProviderCodes) {
    if (!(new RegExp(rule.pattern, "u")).test(normalized)) continue;
    return {
      category: rule.category,
      quotaScope: rule.quotaScope,
      providerCode,
      evidenceSource: { kind: "structured" },
    };
  }
  return null;
}

function classifyStructuredTerminalFailure(providerId, event) {
  const terminal = readProviderTerminalShape(providerId, event);
  if (!terminal) return null;
  const envelope = readStructuredTerminalEnvelope(terminal.errorMessage);
  if (!envelope) return null;
  const failure =
    classifyStructuredProviderCode(envelope.providerError.type)
    || classifyStructuredResponseStatus(envelope.status);
  return failure
    ? { failure, httpStatus: envelope.status }
    : null;
}

function classifyFailure(structured, pinned) {
  if (
    structured
    && structured.category === "rate_limit"
    && pinned
    && pinned.category === "usage_limit"
  ) {
    return pinned;
  }
  return structured || pinned;
}

async function reportFailure(failure, exactStatus, lease, signal) {
  const evidence = {
    ...(exactStatus === null ? {} : { httpStatus: exactStatus }),
    ...(failure.providerCode ? { providerCode: failure.providerCode } : {}),
    limitCategory: failure.category,
    quotaScope: failure.quotaScope,
    evidenceSource: failure.evidenceSource,
  };
  if (failure.category === "auth_invalid") {
    return await reportConnectedAccountAuthFailure({
      credentialContext: lease.credentialContext,
      normalizedFailure: {
        class: "authentication",
        evidence,
      },
      signal,
    });
  }
  return await reportConnectedAccountQuotaFailure({
    credentialContext: lease.credentialContext,
    normalizedFailure: {
      class: "quota",
      evidence,
    },
    signal,
  });
}

function wrapProviderStream(providerId, purpose, baseStream) {
  return function happierRequestAuthStream(model, context, options = {}) {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      let retryUsed = false;
      let withheldLeafTerminal = null;
      let payloadReady = false;
      let payloadSnapshot;

      const replayPayload = async (payload, payloadModel) => {
        if (!payloadReady) {
          const shaped = typeof options.onPayload === "function"
            ? await options.onPayload(payload, payloadModel)
            : undefined;
          payloadSnapshot = structuredClone(shaped === undefined ? payload : shaped);
          payloadReady = true;
        }
        return structuredClone(payloadSnapshot);
      };

      try {
        while (true) {
          if (options.signal && options.signal.aborted) throw options.signal.reason;
          requireProviderTargetOrigin(providerId, model);
          // Exactly one fresh local lookup immediately before each independent upstream attempt.
          const lease = await lookupConnectedAccountRequestAuth({
            purpose,
            signal: options.signal,
          });
          if (providerId === "openai-codex") {
            validateCodexAccountHeader(lease.accessToken, lease.requiredHeaders);
          }

          let response = null;
          let responseObserved = false;
          let responseEventEscaped = false;
          const attemptOptions = {
            ...options,
            apiKey: lease.accessToken,
            headers: mergeAttemptHeaders(providerId, options.headers, lease.requiredHeaders),
            maxRetries: 0,
            ...(providerId === "openai-codex" ? { transport: "sse" } : {}),
            onPayload: replayPayload,
            onResponse: async (observed, responseModel) => {
              response = observed;
              responseObserved = true;
              if (typeof options.onResponse === "function") {
                await options.onResponse(observed, responseModel);
              }
            },
          };

          let terminalError = null;
          const attempt = baseStream(model, context, attemptOptions);
          for await (const event of attempt) {
            if (event && event.type === "error") {
              terminalError = event;
              break;
            }
            responseEventEscaped = true;
            outer.push(event);
          }

          if (!terminalError) {
            withheldLeafTerminal = null;
            outer.end();
            return;
          }

          const observedStatus = responseObserved && response
            && Number.isInteger(response.status)
            ? response.status
            : null;
          const structuredTerminal =
            classifyStructuredTerminalFailure(providerId, terminalError);
          const structuredResponseFailure =
            classifyStructuredResponseStatus(observedStatus);
          const matchedStructuredTerminal = (
            structuredTerminal
            && observedStatus !== null
            && observedStatus === structuredTerminal.httpStatus
          )
            ? structuredTerminal
            : null;
          const exactTransientStatus = responseObserved && response
            && isPiObservedResponseRetryableStatus(response.status);
          const pinned = parsePinnedTerminalEvidence(providerId, terminalError);
          const pinnedTransient = parsePinnedTransientTerminal(providerId, terminalError);
          const structuredFailure =
            matchedStructuredTerminal?.failure
            || structuredResponseFailure
            || null;
          const structuredHttpStatus =
            matchedStructuredTerminal?.httpStatus
            ?? (structuredResponseFailure ? observedStatus : null)
            ?? null;
          const failure = classifyFailure(structuredFailure, pinned);
          const levelBAdmitted =
            observedStatus === null && pinned && !responseEventEscaped;
          let outcome = null;
          if (
            failure
            && !responseEventEscaped
            && (structuredFailure !== null || levelBAdmitted)
          ) {
            try {
              outcome = await reportFailure(
                failure,
                structuredHttpStatus ?? failure.httpStatus ?? null,
                lease,
                options.signal,
              );
            } catch {
              // Preserve the exact upstream terminal failure when reporting is unavailable.
            }
          }

          if (options.signal && options.signal.aborted) {
            outer.push(withoutPiAgentSessionReplay(terminalError));
            outer.end();
            return;
          }

          const piRetryable = piAgentSessionWouldRetry(terminalErrorMessage(terminalError));
          const leafReplayOwner = failure
            && isPiReplayTopologyAdmitted()
            && !piRetryable
            && (failure.category === "auth_invalid" || failure.category === "usage_limit");
          const retrySafe = !retryUsed
            && !responseEventEscaped
            && payloadReady
            && leafReplayOwner
            && (structuredFailure !== null || levelBAdmitted)
            && canRetryAfterOutcome(outcome)
            && !(options.signal && options.signal.aborted);
          if (retrySafe) {
            retryUsed = true;
            withheldLeafTerminal = terminalError;
            continue;
          }

          withheldLeafTerminal = null;
          const piReplaySafe = piRetryable
            && !responseEventEscaped
            && !(options.signal && options.signal.aborted)
            && (
              structuredFailure !== null
              || exactTransientStatus
              || pinnedTransient
              || (pinned && pinned.piRetryable)
            );
          outer.push(
            piReplaySafe
              ? withProviderDiagnostic(terminalError)
              : withoutPiAgentSessionReplay(terminalError),
          );
          outer.end();
          return;
        }
      } catch (error) {
        outer.push(
          withheldLeafTerminal
            ? withoutPiAgentSessionReplay(withheldLeafTerminal)
            : syntheticErrorEvent(model, error, options.signal),
        );
        outer.end();
      }
    })();
    return outer;
  };
}

function requestAuthOnlyProviderAuth() {
  return {
    apiKey: {
      name: "Happier connected account",
      async check() {
        return { type: "api_key", source: "Happier connected account" };
      },
      async resolve() {
        // This value only satisfies Pi's synchronous configured-provider gate. The complete Provider
        // wrapper replaces it with a fresh lease before invoking an upstream stream.
        return {
          auth: { apiKey: REQUEST_AUTH_PLACEHOLDER },
          source: "Happier connected account",
        };
      },
    },
  };
}

function buildWrappedProvider(base, purpose) {
  requireProviderTargetOrigin(base.id, {
    provider: base.id,
    baseUrl: base.baseUrl,
  });
  return {
    ...base,
    auth: requestAuthOnlyProviderAuth(),
    stream: wrapProviderStream(base.id, purpose, base.stream.bind(base)),
    streamSimple: wrapProviderStream(base.id, purpose, base.streamSimple.bind(base)),
  };
}

export default async function HappierPiRequestAuthExtension(pi) {
  if (!pi || typeof pi.registerProvider !== "function") {
    throw new Error("happier_pi_request_auth_complete_provider_unavailable");
  }
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  let registered = 0;
  for (const providerId of ["anthropic", "openai-codex"]) {
    const purpose = PROVIDER_PURPOSES[providerId];
    if (!purpose) continue;
    const base = builtins.get(providerId);
    if (!base) throw new Error("happier_pi_request_auth_builtin_provider_missing:" + providerId);
    pi.registerProvider(buildWrappedProvider(base, purpose));
    registered += 1;
  }
  if (registered === 0) {
    throw new Error("happier_pi_request_auth_purpose_missing");
  }
}
`;
}
