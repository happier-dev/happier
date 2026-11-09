import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { buildChangesReadRequest, ChangeEntrySchema, ChangesResponseSchema, CursorGoneErrorSchema } from '@happier-dev/protocol/changes';
import type { ChangeEntry, ChangeKind, ChangesResponse, CursorGoneError } from '@happier-dev/protocol/changes';
import axios from '@/api/client/credentialAxios';
import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus } from './client/httpStatusError';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';

export {
  ChangeEntrySchema,
  ChangesResponseSchema,
  CursorGoneErrorSchema,
  type ChangeEntry,
  type ChangesResponse,
  type CursorGoneError,
};

export const DEFAULT_ACCOUNT_CHANGES_PAGE_LIMIT = 200;

export async function fetchChangesAccountId(opts: {
  token: string;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const serverUrl = (opts.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const response = await axios.get(`${serverUrl}/v1/account/profile`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(
      response.status,
      `Authentication failed while fetching account profile (${response.status})`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw createHttpStatusError(response.status, `Failed to fetch account profile (${response.status})`);
  }

  const data = response.data as { id?: unknown };
  const id = data.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Invalid /v1/account/profile response');
  }
  return id;
}

export async function fetchChanges(opts: { token: string; after: number; limit?: number; kinds?: readonly ChangeKind[]; sessionAccessSessionId?: string; signal?: AbortSignal }): Promise<{
  status: 'ok';
  response: ChangesResponse;
} | {
  status: 'cursor-gone';
  currentCursor: number;
} | {
  status: 'error';
  error: unknown;
}> {
  const after = Number.isFinite(opts.after) && opts.after >= 0 ? Math.floor(opts.after) : 0;
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 500) : DEFAULT_ACCOUNT_CHANGES_PAGE_LIMIT;
  const serverUrl = resolveServerHttpBaseUrl();
  const read = buildChangesReadRequest({ after, limit, kinds: opts.kinds, sessionAccessSessionId: opts.sessionAccessSessionId });

  try {
    const response = await axios.get(`${serverUrl}${read.path}`, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${opts.token}`,
        ...read.headers,
      },
      timeout: 15_000,
      ...(opts.signal ? { signal: opts.signal } : {}),
      validateStatus: () => true,
    });

    if (response.status === 410) {
      const parsed = CursorGoneErrorSchema.safeParse(response.data);
      if (parsed.success) {
        return { status: 'cursor-gone', currentCursor: parsed.data.currentCursor };
      }
      return { status: 'error', error: parsed.error };
    }

    if (response.status < 200 || response.status >= 300) {
      if (isAuthenticationStatus(response.status)) {
        return {
          status: 'error',
          error: createAuthenticationHttpStatusError(response.status, `Authentication failed while fetching changes (${response.status})`),
        };
      }
      return { status: 'error', error: { status: response.status, body: response.data } };
    }

    const parsed = ChangesResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      return { status: 'error', error: parsed.error };
    }

    return { status: 'ok', response: parsed.data };
  } catch (error) {
    return { status: 'error', error };
  }
}
