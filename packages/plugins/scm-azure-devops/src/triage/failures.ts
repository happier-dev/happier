import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import { AZURE_DEVOPS_REST_FLOOR } from './apiVersions.js';
import { truncateUtf8 } from './decode.js';
import {
  readAzureDevOpsRateLimitEvidence,
  resolveAzureDevOpsRetryNotBeforeMs,
} from './rateLimit.js';
import type {
  AzureDevOpsFailure,
  AzureDevOpsFailureClass,
  AzureDevOpsRateLimitEvidence,
} from './types.js';

/** Bounded, non-secret provider detail. Bodies are never carried through verbatim. */
export const MAX_AZURE_FAILURE_DETAIL_UTF8_BYTES = 1024;

/**
 * Azure DevOps answers an unusable credential by **intercepting the request with a sign-in
 * page** rather than returning `401`. The documented-looking status is `203 Non-Authoritative
 * Information` (a `302` to the login host is the other observed form), and the body is HTML.
 * A client that trusts the status code reads this as a success and then fails to parse JSON,
 * reporting "malformed response" for what is really an expired token. Detection is therefore
 * by HTML content on any 2xx, which covers the `203` form without misclassifying a `203` that
 * actually carries API JSON.
 */

/**
 * Classify an Azure DevOps response. Returns `null` when the response is a usable success.
 *
 * Nothing here waits, sleeps, or schedules: a rate limit is an ordinary failure carrying the
 * provider's own retry evidence, and the caller decides what to do with it.
 */
export function classifyAzureDevOpsResponse(input: Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
  nowMs: number;
}>): AzureDevOpsFailure | null {
  const { status, headers, bodyText, nowMs } = input;
  const rateLimit = readAzureDevOpsRateLimitEvidence(headers);
  const retryNotBeforeMs = resolveAzureDevOpsRetryNotBeforeMs(rateLimit, nowMs);

  if (isSignInInterception(status, headers, bodyText)) {
    return failure({
      failureClass: 'unauthorized',
      status,
      // Deliberately fixed text: the intercepting page carries request context we never echo.
      detail: 'Azure DevOps answered with a sign-in page instead of API content.',
      typeKey: null,
      retryNotBeforeMs,
      rateLimit,
    });
  }

  if (status >= 300 && status < 400) {
    return failure({
      failureClass: 'unexpectedRedirect',
      status,
      detail: 'Azure DevOps redirected an API request.',
      typeKey: null,
      retryNotBeforeMs,
      rateLimit,
    });
  }

  if (status >= 200 && status < 300) return null;

  const body = readAzureErrorBody(bodyText);
  const serviceError = readServiceErrorHeader(headers);
  const detail = body.message ?? serviceError ?? `Azure DevOps returned HTTP ${status}.`;

  if (isRestVersionRefusal(body.typeKey)) {
    return failure({
      failureClass: 'restVersionUnsupported',
      status,
      // Azure's own message names the highest version this deployment serves, which is the one
      // fact an operator needs; the pinned floor is stated alongside it rather than instead of it.
      detail: `${detail} This build is pinned to Azure DevOps REST ${AZURE_DEVOPS_REST_FLOOR}.`,
      typeKey: body.typeKey,
      retryNotBeforeMs,
      rateLimit,
    });
  }

  return failure({
    failureClass: classifyStatus(status),
    status,
    detail,
    typeKey: body.typeKey,
    retryNotBeforeMs,
    rateLimit,
  });
}

/**
 * Whether this signal was aborted by a deadline rather than by its caller.
 *
 * The two are indistinguishable at the `aborted` flag and must not be reported
 * as the same thing. A caller cancellation is the mount going away, and nobody
 * is waiting for the answer; a deadline is a provider that accepted the request
 * and then neither answered nor failed, while the reader is still looking at the
 * panel. The owner that installs the deadline aborts with a `TimeoutError` —
 * the same reason `AbortSignal.timeout` uses, and the reason `AbortSignal.any`
 * propagates from whichever of its inputs fired first.
 */
export function isAzureDevOpsDeadlineAbort(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return typeof reason === 'object'
    && reason !== null
    && (reason as Readonly<{ name?: unknown }>).name === 'TimeoutError';
}

export function classifyAzureDevOpsTransportFailure(input: Readonly<{
  error: unknown;
  signal: AbortSignal;
}>): AzureDevOpsFailure {
  if (input.signal.aborted) {
    const timedOut = isAzureDevOpsDeadlineAbort(input.signal);
    return failure({
      failureClass: timedOut ? 'timedOut' : 'cancelled',
      status: null,
      detail: timedOut
        ? 'Azure DevOps did not answer this request within its deadline.'
        : 'The Azure DevOps request was cancelled.',
      typeKey: null,
      retryNotBeforeMs: null,
      rateLimit: null,
    });
  }
  return failure({
    failureClass: 'transport',
    status: null,
    detail: readErrorMessage(input.error),
    typeKey: null,
    retryNotBeforeMs: null,
    rateLimit: null,
  });
}

export function createAzureDevOpsFailure(input: Readonly<{
  failureClass: AzureDevOpsFailureClass;
  status?: number | null;
  detail: string;
}>): AzureDevOpsFailure {
  return failure({
    failureClass: input.failureClass,
    status: input.status ?? null,
    detail: input.detail,
    typeKey: null,
    retryNotBeforeMs: null,
    rateLimit: null,
  });
}

/**
 * Azure DevOps's own refusal of a pinned `api-version` it cannot serve.
 *
 * The evidence is the provider's stated exception type, not a guess from the status: an Azure
 * DevOps Server older than the 7.1 floor answers `400` with
 * `VssVersionNotSupportedException`, whose message names the highest version it does serve. The
 * `api-supported-versions` response header is deliberately NOT read as a second signal — Azure
 * emits it on successful responses too, and treating a version list that does not literally
 * contain the pinned string as a refusal would take a working deployment offline on a formatting
 * difference. This classifier fires only where Azure itself refused.
 */
function isRestVersionRefusal(typeKey: string | null): boolean {
  return typeKey !== null && typeKey.toLowerCase().startsWith('vssversionnotsupported');
}

function classifyStatus(status: number): AzureDevOpsFailureClass {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  // Azure documents 404 as nonexistent **or** not permitted to view, and no second read
  // separates them. Collapsing it to "absent" would delete rows a user simply cannot see.
  if (status === 404) return 'notFoundOrForbidden';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rateLimit';
  if (status >= 500) return 'server';
  return 'invalidRequest';
}

/**
 * The interception is identified by HTML *content* on a 2xx, not by the status alone: a bare
 * `203` from an intermediary carrying real JSON is a usable response, and misreading it as an
 * expired credential would discard valid data.
 */
function isSignInInterception(
  status: number,
  headers: Readonly<Record<string, string>>,
  bodyText: string,
): boolean {
  if (status < 200 || status >= 300) return false;
  return looksLikeHtml(headers, bodyText);
}

function looksLikeHtml(
  headers: Readonly<Record<string, string>>,
  bodyText: string,
): boolean {
  const contentType = readTriageResponseHeaderV1(headers, 'content-type');
  if (contentType !== null && contentType.toLowerCase().includes('text/html')) return true;
  const prefix = bodyText.trimStart().slice(0, 64).toLowerCase();
  return prefix.startsWith('<!doctype html') || prefix.startsWith('<html');
}

function readServiceErrorHeader(headers: Readonly<Record<string, string>>): string | null {
  const raw = readTriageResponseHeaderV1(headers, 'x-tfs-serviceerror');
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw.replace(/\+/gu, ' '));
  } catch {
    return raw;
  }
}

function readAzureErrorBody(bodyText: string): Readonly<{
  message: string | null;
  typeKey: string | null;
}> {
  if (bodyText.trim().length === 0) return { message: null, typeKey: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { message: null, typeKey: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { message: null, typeKey: null };
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  return {
    message: typeof record.message === 'string' && record.message.trim().length > 0
      ? record.message.trim()
      : null,
    typeKey: typeof record.typeKey === 'string' && record.typeKey.trim().length > 0
      ? record.typeKey.trim()
      : null,
  };
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  return 'The Azure DevOps request failed before a response was received.';
}

function failure(input: Readonly<{
  failureClass: AzureDevOpsFailureClass;
  status: number | null;
  detail: string;
  typeKey: string | null;
  retryNotBeforeMs: number | null;
  rateLimit: AzureDevOpsRateLimitEvidence | null;
}>): AzureDevOpsFailure {
  return {
    class: input.failureClass,
    status: input.status,
    detail: truncateUtf8(input.detail, MAX_AZURE_FAILURE_DETAIL_UTF8_BYTES).value,
    typeKey: input.typeKey,
    retryNotBeforeMs: input.retryNotBeforeMs,
    rateLimit: input.rateLimit,
  };
}
