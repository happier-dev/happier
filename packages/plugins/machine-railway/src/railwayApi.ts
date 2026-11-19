import { createMachineProvisionerFetch, projectMachineProvisionerActionFailure } from '@happier-dev/plugin-sdk/machine-provisioners';

// Railway Public API: https://docs.railway.com/integrations/api
export const RAILWAY_ORIGIN = 'https://backboard.railway.com';
export const RAILWAY_API = RAILWAY_ORIGIN + '/graphql/v2';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const ORIGINS = [RAILWAY_ORIGIN] as const;

export function nativeFetch(
  context: Parameters<typeof createMachineProvisionerFetch>[0],
  credential?: string | Readonly<Record<string, string>>,
): typeof fetch {
  return createMachineProvisionerFetch(context, {
    purpose: ACCOUNT_PURPOSE, origins: ORIGINS, headerName: 'authorization',
    credential: typeof credential === 'string' ? { authorization: 'Bearer ' + credential } : credential,
  });
}

export class NativeError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
  }
}

export function railwayErrorCode(error: unknown): string {
  if (error instanceof NativeError) return error.code;
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'credential_unavailable') {
    return 'credential_unavailable';
  }
  return 'railway_unavailable';
}

/** The request adapter carries the invocation's admitted Connected Account. */
export function createRailwayGraphqlClient(request: typeof fetch, signal?: AbortSignal) {
  return async (query: string, variables: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    try {
      signal?.throwIfAborted();
      const response = await request(RAILWAY_API, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'credential_unavailable' : 'railway_http_' + response.status;
        throw new NativeError(code, response.status);
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') throw new NativeError('railway_invalid_response');
      // HTTP 200 does not establish GraphQL success. Never forward vendor error prose.
      if ('errors' in body && (!Array.isArray(body.errors) || body.errors.length > 0)) {
        throw new NativeError('railway_graphql_unavailable');
      }
      if (!('data' in body) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
        throw new NativeError('railway_invalid_response');
      }
      return body.data as Record<string, unknown>;
    } catch (error) {
      return projectMachineProvisionerActionFailure(error, () => {
        throw error instanceof NativeError ? error : new NativeError(railwayErrorCode(error));
      });
    }
  };
}
