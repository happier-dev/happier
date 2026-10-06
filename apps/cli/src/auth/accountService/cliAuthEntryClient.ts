import { AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1, AuthEntryProjectionV1Schema, AuthEntryRequestV1Schema } from '@happier-dev/protocol/auth/entry';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol';

import { normalizeBaseUrl, withAbortTimeout } from '@/diagnostics/httpClient';
import { decodeBoundedJsonResponseBody } from '@/features/serverFeaturesParse';

type CliHomeAuthEntryProjection = Extract<
  AuthEntryProjectionV1,
  Readonly<{ scope: Readonly<{ kind: 'home' }> }>
>;

function isCliHomeAuthEntryProjection(
  projection: AuthEntryProjectionV1,
): projection is CliHomeAuthEntryProjection {
  switch (projection.scope.kind) {
    case 'home':
      return true;
    case 'team':
    case 'invitation':
      return false;
  }
}

export type CliAuthEntryFetchResult =
  | Readonly<{ kind: 'ready'; projection: CliHomeAuthEntryProjection }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'incompatible' }>
  | Readonly<{ kind: 'unavailable' }>;

function isUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

export async function fetchCliHomeAuthEntry(input: Readonly<{
  serverUrl: string;
  purpose?: 'home' | 'account_service';
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<CliAuthEntryFetchResult> {
  try {
    const body = AuthEntryRequestV1Schema.parse({
      v: 1,
      scope: { kind: 'home' },
      ...(input.purpose && input.purpose !== 'home' ? { purpose: input.purpose } : {}),
    });
    const response = await withAbortTimeout(
      input.timeoutMs ?? 6_000,
      async (signal) => await fetch(`${normalizeBaseUrl(input.serverUrl)}/v1/auth/entry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
      input.signal,
    );
    if (isUnsupportedStatus(response.status)) return { kind: 'unsupported' };
    if (!response.ok) return { kind: 'unavailable' };
    const raw = await decodeBoundedJsonResponseBody(
      response.body,
      response.headers.get('content-length'),
      AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1,
    );
    if (raw === null) return { kind: 'incompatible' };
    const parsed = AuthEntryProjectionV1Schema.safeParse(raw);
    return parsed.success && isCliHomeAuthEntryProjection(parsed.data)
      ? { kind: 'ready', projection: parsed.data }
      : { kind: 'incompatible' };
  } catch {
    if (input.signal?.aborted) input.signal.throwIfAborted();
    return { kind: 'unavailable' };
  }
}
