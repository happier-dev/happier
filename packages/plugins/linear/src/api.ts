import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
export type LinearSourceContext = Pick<PluginAccountActionContext, 'signal'> & Readonly<{
    services: Pick<PluginAccountActionContext['services'], 'http' | 'connectedAccounts'>;
}>;
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { materializeTriageSourceAuthorizationV1, parseRetryAfterNotBeforeMsV1 } from '@happier-dev/triage-sources/runtime';
import { LINEAR_ORIGIN, LINEAR_PURPOSE } from './contracts.js';

export class LinearRequestError extends Error {
  constructor(readonly failure: TriageSourceFailureV1) { super(failure.code); }
}
export function linearFailure(code: string, classification: TriageSourceFailureV1['class'] = 'unsupportedContract'): LinearRequestError {
  return new LinearRequestError({ class: classification, code: `linear/${code}` });
}
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw linearFailure('responseInvalid');
  return value as Record<string, unknown>;
}
export function failureFrom(error: unknown, signal: AbortSignal): TriageSourceFailureV1 {
  if (signal.aborted) return { class: 'transient', code: 'linear/cancelled' };
  return error instanceof LinearRequestError ? error.failure : { class: 'transient', code: 'linear/transportFailed' };
}
function retryDeadline(headers: Readonly<Record<string, string>>, nowMs: number): number | undefined {
  const normalized = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const deadlines: number[] = [];
  const retryAfter = parseRetryAfterNotBeforeMsV1(normalized.get('retry-after') ?? null, nowMs);
  if (retryAfter !== null) deadlines.push(retryAfter);
  // Linear resets are epoch milliseconds. Only exhausted budgets constrain a
  // subsequent request; a healthy request budget cannot mask complexity exhaustion.
  for (const budget of ['requests', 'endpoint-requests', 'complexity']) {
    if (normalized.get(`x-ratelimit-${budget}-remaining`)?.trim() !== '0') continue;
    const raw = normalized.get(`x-ratelimit-${budget}-reset`);
    if (raw === undefined || !/^\d+$/u.test(raw)) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value)) deadlines.push(value);
  }
  return deadlines.length === 0 ? undefined : Math.max(...deadlines);
}

/** One request, no retry or timer; the host owns credentials and invocation lifetime. */
export async function requestLinearGraphql(input: Readonly<({
  context: { services: Pick<PluginAccountActionContext['services'], 'http'>; signal: AbortSignal };
  authorization: string; account?: never;
} | {
  context: Pick<LinearSourceContext, 'services' | 'signal'>;
  account: ConnectedAccountRef; authorization?: never;
}) & {
  operationName: string;
  query: string; variables?: Readonly<Record<string, unknown>>;
}>): Promise<Record<string, unknown>> {
  const { context } = input;
  context.signal.throwIfAborted();
  let authorization: string;
  if (input.authorization === undefined) {
    if (input.account === undefined) throw linearFailure('accountMissing', 'authentication');
    const materialized = await materializeTriageSourceAuthorizationV1({
      connectedAccounts: input.context.services.connectedAccounts, purpose: LINEAR_PURPOSE,
      account: input.account, origin: LINEAR_ORIGIN, signal: context.signal,
    });
    if (!materialized.ok) throw materialized.failure === undefined
      ? linearFailure(materialized.reason, 'authentication')
      : new LinearRequestError(materialized.failure);
    authorization = materialized.authorization;
  } else {
    authorization = input.authorization;
  }
  context.signal.throwIfAborted();
  const response = await context.services.http.request({
    url: `${LINEAR_ORIGIN}/graphql`, method: 'POST', redirect: 'error',
    headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ operationName: input.operationName, query: input.query, variables: input.variables ?? {} })),
  }, { signal: context.signal });
  context.signal.throwIfAborted();
  let envelope: Record<string, unknown> = {};
  try { envelope = record(JSON.parse(new TextDecoder().decode(response.body))); } catch {
    if (response.status >= 200 && response.status < 300) throw linearFailure('responseInvalid');
  }
  const codes = Array.isArray(envelope.errors) ? envelope.errors.map((error) => {
    try { return record(record(error).extensions).code; } catch { return undefined; }
  }) : [];
  if (response.status === 429 || codes.includes('RATELIMITED')) {
    const retryNotBeforeMs = retryDeadline(response.headers, Date.now());
    throw new LinearRequestError({ class: 'rateLimit', code: 'linear/rateLimited', ...(retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs }) });
  }
  if (response.status === 401 || codes.includes('AUTHENTICATION_ERROR') || codes.includes('UNAUTHENTICATED')) throw linearFailure('authenticationFailed', 'authentication');
  if (response.status === 403 || codes.includes('FORBIDDEN')) throw linearFailure('permissionDenied', 'permission');
  if (response.status >= 500) throw linearFailure('upstreamUnavailable', 'transient');
  if (response.status < 200 || response.status >= 300 || codes.length > 0) throw linearFailure('queryRejected');
  return record(envelope.data);
}

export function connection(value: unknown, direction: 'forward' | 'backward' = 'forward'): Readonly<{ nodes: unknown[]; after?: string }> {
  const data = record(value);
  const info = record(data.pageInfo);
  const hasMore = direction === 'backward' ? info.hasPreviousPage : info.hasNextPage;
  const cursor = direction === 'backward' ? info.startCursor : info.endCursor;
  if (!Array.isArray(data.nodes) || typeof hasMore !== 'boolean') throw linearFailure('pageInvalid');
  if (hasMore && (typeof cursor !== 'string' || cursor.length === 0)) throw linearFailure('cursorMissing');
  // Relay keeps the native edge order for last/before. Traversing backwards
  // reverses that page as well, so pages concatenate into ascending order.
  return { nodes: direction === 'backward' ? [...data.nodes].reverse() : data.nodes, ...(hasMore ? { after: String(cursor) } : {}) };
}

// Explicit provider-default geometry, never a result ceiling: every connection
// is paged. Scalars/singletons plus one filtered viewer subscriber keep the
// 50-issue query below 1,000 points (Linear's per-query limit is 10,000).
// https://linear.app/developers/pagination and /rate-limiting
export const LINEAR_PAGE_SIZE = 50;
export const LINEAR_ISSUE_FIELDS = `
  id identifier title url createdAt updatedAt completedAt priority priorityLabel dueDate estimate
  team { id key name } state { id name type } assignee { id name } creator { id name }
  project { id name } cycle { id name number } parent { id identifier title }
  subscribers(first: 1, filter: { id: { eq: $viewerId } }) { nodes { id } }
`;
export const LINEAR_PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
