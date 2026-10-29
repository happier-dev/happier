import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION,
  SESSION_ORGANIZATION_MAX_FOLDERS,
  SESSION_ORGANIZATION_MAX_LABELS,
  SESSION_ORGANIZATION_MAX_PINNED_SESSIONS,
  SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS,
  SESSION_ORGANIZATION_MAX_TAGS,
  SESSION_ORGANIZATION_SNAPSHOT_VERSION,
} from './constants.js';
import { SessionFolderAssignmentSchema, SessionOrganizationFolderSchema } from './folders.js';
import { SessionOrganizationLabelSchema, SessionOrganizationOrderEntrySchema } from './ordering.js';
import { SessionOrganizationPinSchema } from './pins.js';
import { SessionAttentionStandingSchema } from './standings.js';
import { SessionOrganizationTagSchema, SessionTagAssignmentSchema } from './tags.js';

const SessionOrganizationScopedIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(10_000)));

const SessionOrganizationOrderScopeRequestSchema = lazyZodSchema(() => z.pick(SessionOrganizationOrderEntrySchema, {
  scopeKind: true,
  scopeKey: true,
}));

export const SessionOrganizationSnapshotRequestSchema = lazyZodSchema(() => z.strictObject({
    projectionVersion: z.optional(z.literal(SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION)),
    includeFolders: z._default(z.boolean(), true),
    includeTags: z._default(z.boolean(), true),
    includeLabels: z._default(z.boolean(), true),
    includeAllFolderAssignments: z._default(z.boolean(), false),
    includeAllTagAssignments: z._default(z.boolean(), false),
    assignmentSessionIds: z._default(z.array(SessionOrganizationScopedIdSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS)), []),
    folderIds: z._default(z.array(SessionOrganizationScopedIdSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS)), []),
    tagIds: z._default(z.array(SessionOrganizationScopedIdSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS)), []),
    orderScopes: z._default(z.array(SessionOrganizationOrderScopeRequestSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS)), []),
    includeAttentionStandings: z._default(z.boolean(), false),
    includeAttentionReminderTimes: z._default(z.boolean(), false),
  }));
export type SessionOrganizationSnapshotRequest = z.infer<typeof SessionOrganizationSnapshotRequestSchema>;

/** The existing HTTP query codec, shared by the route and signed-phase admission. */
export function sessionOrganizationSnapshotRequestFromQueryV1(query: unknown): Readonly<Record<string, unknown>> {
  const record = query && typeof query === 'object' ? query as Record<string, unknown> : {};
  const boolean = (value: unknown): boolean | undefined => value === true || value === 'true' || value === '1' ? true
    : value === false || value === 'false' || value === '0' ? false : undefined;
  const list = (value: unknown): string[] | undefined => {
    if (typeof value !== 'string') return undefined;
    const values = [...new Set(value.split(',').map(entry => entry.trim()).filter(Boolean))];
    return values.length ? values : undefined;
  };
  const orderScopes = (() => {
    if (typeof record.orderScopes !== 'string') return undefined;
    try { const value: unknown = JSON.parse(record.orderScopes); return Array.isArray(value) ? value : [{}]; }
    catch { return [{}]; }
  })();
  const result: Record<string, unknown> = {};
  if (record.projectionVersion !== undefined) result.projectionVersion = record.projectionVersion === String(SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION)
    ? SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION : record.projectionVersion;
  for (const key of ['includeFolders', 'includeTags', 'includeLabels', 'includeAllFolderAssignments',
    'includeAllTagAssignments', 'includeAttentionStandings', 'includeAttentionReminderTimes', 'includeSessionAppearances'] as const) {
    const value = boolean(record[key]);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ['assignmentSessionIds', 'folderIds', 'tagIds'] as const) {
    const value = list(record[key]);
    if (value) result[key] = value;
  }
  if (orderScopes) result.orderScopes = orderScopes;
  return result;
}

/** Exact existing assignment read shared by transports and signed-purpose admission. */
export function buildSessionOrganizationAssignmentSnapshotHttpRequestV1(sessionIds: readonly string[]) {
  const request = SessionOrganizationSnapshotRequestSchema.parse({ includeFolders: false, includeTags: false, includeLabels: false,
    assignmentSessionIds: [...new Set(sessionIds.map(id => id.trim()).filter(Boolean))] });
  if (!request.assignmentSessionIds.length) throw new TypeError('Session assignments require named Session ids');
  const query = { includeFolders: 'false', includeTags: 'false', includeLabels: 'false',
    assignmentSessionIds: request.assignmentSessionIds.join(',') };
  return { method: 'GET' as const, path: `/v2/session-organization?${new URLSearchParams(query)}`, query };
}

export const SessionOrganizationSnapshotSchema = lazyZodSchema(() => z.strictObject({
    schemaVersion: z.literal(SESSION_ORGANIZATION_SNAPSHOT_VERSION),
    version: z.number().check(z.int(), z.nonnegative()),
    pins: z.array(SessionOrganizationPinSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_PINNED_SESSIONS)),
    folders: z.array(SessionOrganizationFolderSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_FOLDERS)),
    folderAssignments: z.array(SessionFolderAssignmentSchema),
    tags: z.array(SessionOrganizationTagSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_TAGS)),
    tagAssignments: z.array(SessionTagAssignmentSchema),
    orderEntries: z.array(SessionOrganizationOrderEntrySchema),
    labels: z.array(SessionOrganizationLabelSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_LABELS)),
    attentionStandings: z.optional(z.array(SessionAttentionStandingSchema)),
  }));
export type SessionOrganizationSnapshot = z.infer<typeof SessionOrganizationSnapshotSchema>;

export const SessionOrganizationSnapshotResponseSchema = lazyZodSchema(() => z.strictObject({
    snapshot: SessionOrganizationSnapshotSchema,
  }));
export type SessionOrganizationSnapshotResponse = z.infer<typeof SessionOrganizationSnapshotResponseSchema>;
