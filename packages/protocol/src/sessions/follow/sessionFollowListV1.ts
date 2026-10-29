import { z } from 'zod/mini';
import { FollowSourceRefV1Schema } from './sessionDeliveryMuteV1.js';

/** No implicit truncation: callers may choose a page size, otherwise all admitted rows are returned. */
export const FollowListPageRequestV1Schema = z.strictObject({
  cursor: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.positive())),
});
export const FollowListPageQueryV1Schema = z.strictObject({
  cursor: FollowListPageRequestV1Schema.shape.cursor,
  limit: z.optional(z.coerce.number().check(z.int(), z.positive())),
});
export type FollowListPageRequestV1 = z.infer<typeof FollowListPageRequestV1Schema>;
/** Session selection includes that Session's execution Runs; other refs are exact. Rules have their private reader. */
export const FollowListRequestV1Schema = z.strictObject({
  ...FollowListPageRequestV1Schema.shape,
  source: z.optional(FollowSourceRefV1Schema.check(z.refine(source => source.kind !== 'rule'))),
  sourceKinds: z.optional(z.array(z.enum(['session', 'discussion', 'execution_run', 'workflow_run'])).check(z.minLength(1))),
});
export type FollowListRequestV1 = z.infer<typeof FollowListRequestV1Schema>;
/** Kind selection is a set; equivalent requests retain the same continuation scope. */
export function parseFollowListRequestV1(input: unknown): FollowListRequestV1 {
  const request = FollowListRequestV1Schema.parse(input);
  return request.sourceKinds === undefined ? request : { ...request, sourceKinds: [...new Set(request.sourceKinds)].sort() };
}
/** Keep the encoded query stable through Fastify's validator and handler validation. */
export const FollowListQueryV1Schema = z.strictObject({
  ...FollowListPageQueryV1Schema.shape,
  source: z.optional(z.string().check(z.minLength(1))),
  sourceKinds: z.optional(z.string().check(z.minLength(1))),
});
export function parseFollowListQueryV1(input: unknown): FollowListRequestV1 {
  const { source, sourceKinds, ...page } = FollowListQueryV1Schema.parse(input);
  return parseFollowListRequestV1({ ...page, ...(source === undefined ? {} : { source: JSON.parse(source) }),
    ...(sourceKinds === undefined ? {} : { sourceKinds: JSON.parse(sourceKinds) }) });
}
export const FollowListPageResultFieldsV1 = {
  continuation: z.optional(z.string().check(z.minLength(1))),
} as const;

const cursorSchema = z.strictObject({ v: z.literal(1), scope: z.string(), after: z.string() });

export function readFollowListCursorV1(scope: string, cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  const parsed = cursorSchema.parse(JSON.parse(cursor));
  if (parsed.scope !== scope) throw new Error('follow_list_cursor_scope_mismatch');
  return parsed.after;
}

export function encodeFollowListCursorV1(scope: string, after: string): string {
  return JSON.stringify({ v: 1, scope, after });
}

/** Source owners page their authorized corpus; a cursor never grants access or freezes membership. */
export function pageFollowListV1<T>(input: FollowListPageRequestV1 & Readonly<{
  scope: string;
  rows: readonly T[];
  key: (row: T) => string;
}>): Readonly<{ rows: T[]; continuation?: string }> {
  const request = FollowListPageRequestV1Schema.parse({ cursor: input.cursor, limit: input.limit });
  const after = readFollowListCursorV1(input.scope, request.cursor);
  const ordered = input.rows.map(row => ({ row, key: input.key(row) }))
    .filter(entry => after === undefined || entry.key > after)
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const selected = request.limit === undefined ? ordered : ordered.slice(0, request.limit);
  const last = selected.at(-1);
  return { rows: selected.map(entry => entry.row), ...(last && selected.length < ordered.length
    ? { continuation: encodeFollowListCursorV1(input.scope, last.key) } : {}) };
}

export function appendFollowListPageQueryV1(path: string, request: FollowListRequestV1): string {
  const selection = parseFollowListRequestV1(request);
  const query = new URLSearchParams();
  if (selection.cursor !== undefined) query.set('cursor', selection.cursor);
  if (selection.limit !== undefined) query.set('limit', String(selection.limit));
  if (selection.source !== undefined) query.set('source', JSON.stringify(selection.source));
  if (selection.sourceKinds !== undefined) query.set('sourceKinds', JSON.stringify(selection.sourceKinds));
  return query.size ? `${path}?${query}` : path;
}
