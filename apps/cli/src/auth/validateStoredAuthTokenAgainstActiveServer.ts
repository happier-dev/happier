import { isAuthenticationStatus } from '@/api/client/httpStatusError';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { withAbortTimeout } from '@/diagnostics/httpClient';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';

import type { HomeEnrollmentCarrierFailure } from '@happier-dev/protocol/ssh/commandFailure';

import {
  TerminalAuthEnrollmentVerificationError,
  verifyTerminalAuthEnrollmentRuntime,
  type TerminalAuthEnrollmentVerificationErrorCode,
} from './terminalAuthEnrollmentClient';
import { acquireTerminalAuthEnrollmentRuntime } from './terminalAuthEnrollmentRuntime';

/**
 * Closed, content-free validation reasons. Nothing from a response body or an
 * error's text passes through: an unrecognized cause maps to a fixed value.
 */
export type StoredTokenValidationReason =
  | HomeEnrollmentCarrierFailure['reason']
  | TerminalAuthEnrollmentVerificationErrorCode
  | 'missing-token'
  | 'missing-server-url'
  | 'invalid-profile-response'
  | 'not_authenticated'
  | 'http_error'
  | 'timeout'
  | 'request_error';

export type ActiveServerStoredTokenValidationResult = Readonly<
  /** `accountLabel`: a readable name for the validated account (username, else display name), never an email. */
  | { state: 'valid'; httpStatus: number; accountLabel?: string | null }
  | { state: 'invalid'; httpStatus: number; reasonCode: StoredTokenValidationReason }
  | { state: 'unknown'; httpStatus: number | null; reasonCode: StoredTokenValidationReason }
>;

type StoredAuthTokenValidationParams = Readonly<{
  token: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Username, else the display name, else null. The profile's email is never used as a label. */
function readAccountProfileLabel(body: unknown): string | null {
  const profile = (body ?? {}) as { username?: unknown; firstName?: unknown; lastName?: unknown };
  const username = readTrimmedString(profile.username);
  if (username) return username;
  const displayName = [readTrimmedString(profile.firstName), readTrimmedString(profile.lastName)]
    .filter(Boolean)
    .join(' ');
  return displayName || null;
}

function readRequestFailureReason(error: unknown): StoredTokenValidationReason {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? 'timeout' : 'request_error';
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function validateStoredAuthTokenAgainstServer(
  params: StoredAuthTokenValidationParams,
): Promise<ActiveServerStoredTokenValidationResult> {
  params.signal?.throwIfAborted();
  const trimmedToken = String(params.token ?? '').trim();
  if (!trimmedToken) {
    return { state: 'invalid', httpStatus: 401, reasonCode: 'missing-token' };
  }
  const baseUrl = String(params.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return { state: 'unknown', httpStatus: null, reasonCode: 'missing-server-url' };
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  try {
    // The body belongs to the same exchange, so its read stays inside this request's deadline.
    const { response, body } = await withAbortTimeout(
      params.timeoutMs ?? 5_000,
      async (requestSignal) => {
        const response = await fetchWithCredentialRedirectRefusal(`${baseUrl}/v1/account/profile`, {
          method: 'GET',
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${trimmedToken}`,
            'Content-Type': 'application/json',
          },
          signal: requestSignal,
        }, fetchImpl);
        return { response, body: await readJsonBody(response) };
      },
      params.signal,
    );

    if (response.ok) {
      const accountId = (body as { id?: unknown } | null)?.id;
      if (typeof accountId === 'string' && accountId.trim().length > 0) {
        return { state: 'valid', httpStatus: response.status, accountLabel: readAccountProfileLabel(body) };
      }
      return { state: 'unknown', httpStatus: response.status, reasonCode: 'invalid-profile-response' };
    }

    if (isAuthenticationStatus(response.status)) {
      return { state: 'invalid', httpStatus: response.status, reasonCode: 'not_authenticated' };
    }

    return { state: 'unknown', httpStatus: response.status, reasonCode: 'http_error' };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof CredentialRequestRedirectError) throw error;
    return {
      state: 'unknown',
      httpStatus: null,
      reasonCode: readRequestFailureReason(error),
    };
  }
}

export async function validateStoredAuthTokenAgainstActiveServer(
  token: string,
  signal?: AbortSignal,
): Promise<ActiveServerStoredTokenValidationResult> {
  signal?.throwIfAborted();
  const target = await resolveCurrentCliHomeTarget().catch(() => null);
  signal?.throwIfAborted();
  if (!target?.descriptor) {
    return validateStoredAuthTokenAgainstServer({
      token,
      baseUrl: resolveServerHttpBaseUrl(),
      ...(signal ? { signal } : {}),
    });
  }

  const acquired = await acquireTerminalAuthEnrollmentRuntime(
    target.descriptor,
    target.preferredTransport,
    signal,
  );
  if (!acquired.ok) {
    // The carrier's typed refusal (for example `identity_mismatch`) is the cause.
    return { state: 'unknown', httpStatus: null, reasonCode: acquired.carrierFailure.reason };
  }
  try {
    const snapshot = await observeServerFeaturesSnapshot({
      serverUrl: acquired.runtime.runtimeOrigin,
      token,
      ...(signal ? { signal } : {}),
    });
    verifyTerminalAuthEnrollmentRuntime({
      target,
      runtime: acquired.runtime,
      snapshot,
    });
    return await validateStoredAuthTokenAgainstServer({
      token,
      baseUrl: acquired.runtime.runtimeOrigin,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CredentialRequestRedirectError) throw error;
    return {
      state: 'unknown',
      httpStatus: null,
      // A verification refusal carries its own typed code, such as `HOME_AUTHORITY_MISMATCH`.
      reasonCode: error instanceof TerminalAuthEnrollmentVerificationError ? error.code : readRequestFailureReason(error),
    };
  } finally {
    await acquired.close().catch(() => undefined);
  }
}
