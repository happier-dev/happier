import { isAuthenticationStatus } from '@/api/client/httpStatusError';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { withAbortTimeout } from '@/diagnostics/httpClient';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';

import { verifyTerminalAuthEnrollmentRuntime } from './terminalAuthEnrollmentClient';
import { acquireTerminalAuthEnrollmentRuntime } from './terminalAuthEnrollmentRuntime';

export type ActiveServerStoredTokenValidationResult = Readonly<
  /** `accountLabel`: a readable name for the validated account (username, else display name), never an email. */
  | { state: 'valid'; httpStatus: number; accountLabel?: string | null }
  | { state: 'invalid'; httpStatus: number; reasonCode: string }
  | { state: 'unknown'; httpStatus: number | null; reasonCode: string }
>;

type StoredAuthTokenValidationParams = Readonly<{
  token: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

function readResponseCode(body: unknown, fallback: string): string {
  return typeof (body as { code?: unknown })?.code === 'string' && (body as { code: string }).code.trim()
    ? (body as { code: string }).code.trim()
    : fallback;
}

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

/** A verification refusal's own typed code, such as `HOME_AUTHORITY_MISMATCH`. */
function readTypedErrorCode(error: unknown): string | null {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && code.trim() ? code : null;
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
      return {
        state: 'invalid',
        httpStatus: response.status,
        reasonCode: readResponseCode(body, 'not_authenticated'),
      };
    }

    return {
      state: 'unknown',
      httpStatus: response.status,
      reasonCode: readResponseCode(body, `http-${response.status}`),
    };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof CredentialRequestRedirectError) throw error;
    return {
      state: 'unknown',
      httpStatus: null,
      reasonCode: error instanceof Error ? error.name : 'request-error',
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
      reasonCode: readTypedErrorCode(error) ?? (error instanceof Error ? error.name : 'home-carrier-verification-failed'),
    };
  } finally {
    await acquired.close().catch(() => undefined);
  }
}
