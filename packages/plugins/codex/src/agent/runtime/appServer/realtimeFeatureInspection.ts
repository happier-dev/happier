import type { DisposableCodexAppServerClient } from './client.js';

const REALTIME_FEATURE = 'realtime_conversation';
const FEATURE_PAGE_LIMIT = 100;
const MAX_FEATURE_PAGES = 100;

export const CODEX_OPERATION_ABORTED = Symbol('codex_operation_aborted');

export type CodexRealtimeFeatureInspection =
  | Readonly<{ status: 'enabled' }>
  | Readonly<{
      status: 'unavailable';
      code:
        | 'feature_not_advertised'
        | 'inspection_aborted'
        | 'currentness_lost'
        | 'authentication_required'
        | 'feature_list_unavailable'
        | 'feature_list_invalid'
        | 'feature_state_invalid'
        | 'feature_state_ambiguous'
        | 'feature_pagination_invalid'
        | 'feature_pagination_incomplete'
        | 'feature_missing'
        | 'feature_disabled';
    }>;

export function waitForCodexOperationOrAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof CODEX_OPERATION_ABORTED> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.resolve(CODEX_OPERATION_ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(CODEX_OPERATION_ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readFeaturePage(value: unknown): Readonly<{
  data: readonly Readonly<Record<string, unknown>>[];
  nextCursor: string | null;
}> | null {
  const record = readRecord(value);
  if (!record || !Array.isArray(record.data)) return null;
  if (record.nextCursor !== null && typeof record.nextCursor !== 'string') return null;
  if (typeof record.nextCursor === 'string' && record.nextCursor.length === 0) return null;
  const data = record.data.map(readRecord);
  if (data.some((entry) => entry === null)) return null;
  return {
    data: data as readonly Readonly<Record<string, unknown>>[],
    nextCursor: record.nextCursor,
  };
}

/**
 * Reads Codex's effective feature list to completion. A thread is optional:
 * normal Voice Start passes its exact loaded thread, while passive setup omits
 * it so the app-server resolves its cold global configuration without creating
 * a thread or realtime session.
 */
export async function inspectCodexRealtimeFeature(params: Readonly<{
  client: DisposableCodexAppServerClient;
  threadId?: string;
  isCurrent?: () => boolean;
  isAuthenticationError?: (error: unknown) => boolean;
  signal?: AbortSignal;
}>): Promise<CodexRealtimeFeatureInspection> {
  if (!params.client.launchFeatures.realtimeConversationAdvertised) {
    return { status: 'unavailable', code: 'feature_not_advertised' };
  }

  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  let featureEnabled: boolean | null = null;
  let completed = false;
  for (let pageNumber = 0; pageNumber < MAX_FEATURE_PAGES; pageNumber += 1) {
    if (params.signal?.aborted) {
      return { status: 'unavailable', code: 'inspection_aborted' };
    }
    if (params.isCurrent?.() === false) {
      return { status: 'unavailable', code: 'currentness_lost' };
    }

    let pageValue: unknown;
    try {
      const pageOutcome = await waitForCodexOperationOrAbort(
        params.client.request('experimentalFeature/list', {
          ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
          cursor,
          limit: FEATURE_PAGE_LIMIT,
        }, ...(params.signal ? [{ signal: params.signal }] : [])),
        params.signal,
      );
      if (pageOutcome === CODEX_OPERATION_ABORTED) {
        return { status: 'unavailable', code: 'inspection_aborted' };
      }
      pageValue = pageOutcome;
    } catch (error) {
      return params.isAuthenticationError?.(error)
        ? { status: 'unavailable', code: 'authentication_required' }
        : { status: 'unavailable', code: 'feature_list_unavailable' };
    }

    const page = readFeaturePage(pageValue);
    if (!page) return { status: 'unavailable', code: 'feature_list_invalid' };
    for (const entry of page.data) {
      if (entry.name !== REALTIME_FEATURE) continue;
      if (typeof entry.enabled !== 'boolean') {
        return { status: 'unavailable', code: 'feature_state_invalid' };
      }
      if (featureEnabled !== null && featureEnabled !== entry.enabled) {
        return { status: 'unavailable', code: 'feature_state_ambiguous' };
      }
      featureEnabled = entry.enabled;
    }
    if (page.nextCursor === null) {
      completed = true;
      break;
    }
    if (seenCursors.has(page.nextCursor)) {
      return { status: 'unavailable', code: 'feature_pagination_invalid' };
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  if (!completed) return { status: 'unavailable', code: 'feature_pagination_incomplete' };
  if (featureEnabled === null) return { status: 'unavailable', code: 'feature_missing' };
  if (!featureEnabled) return { status: 'unavailable', code: 'feature_disabled' };
  return { status: 'enabled' };
}
