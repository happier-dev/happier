import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';

export type ActiveServerStoredTokenValidationResult = Readonly<
  | { state: 'valid'; httpStatus: number }
  | { state: 'invalid'; httpStatus: number; reasonCode: string }
  | { state: 'unknown'; httpStatus: number | null; reasonCode: string }
>;

function readResponseCode(body: unknown, fallback: string): string {
  return typeof (body as { code?: unknown })?.code === 'string' && (body as { code: string }).code.trim()
    ? (body as { code: string }).code.trim()
    : fallback;
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

export async function validateStoredAuthTokenAgainstActiveServer(
  token: string,
): Promise<ActiveServerStoredTokenValidationResult> {
  const trimmedToken = String(token ?? '').trim();
  if (!trimmedToken) {
    return { state: 'invalid', httpStatus: 401, reasonCode: 'missing-token' };
  }

  const baseUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');

  try {
    const response = await fetch(`${baseUrl}/v1/account/profile`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${trimmedToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5_000),
    });

    const body = await readJsonBody(response);
    if (response.ok) {
      const accountId = (body as { id?: unknown } | null)?.id;
      if (typeof accountId === 'string' && accountId.trim().length > 0) {
        return { state: 'valid', httpStatus: response.status };
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
    return {
      state: 'unknown',
      httpStatus: null,
      reasonCode: error instanceof Error ? error.name : 'request-error',
    };
  }
}
