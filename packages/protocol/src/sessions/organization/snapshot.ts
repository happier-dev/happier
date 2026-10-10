import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

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

const SessionOrganizationScopedIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(10_000));

const SessionOrganizationOrderScopeRequestSchema = lazyZodSchema(() => SessionOrganizationOrderEntrySchema.pick({
  scopeKind: true,
  scopeKey: true,
}));

export const SessionOrganizationSnapshotRequestSchema = lazyZodSchema(() => z
  .object({
    projectionVersion: z.literal(SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION).optional(),
    includeFolders: z.boolean().default(true),
    includeTags: z.boolean().default(true),
    includeLabels: z.boolean().default(true),
    includeAllFolderAssignments: z.boolean().default(false),
    includeAllTagAssignments: z.boolean().default(false),
    assignmentSessionIds: z.array(SessionOrganizationScopedIdSchema).max(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS).default([]),
    folderIds: z.array(SessionOrganizationScopedIdSchema).max(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS).default([]),
    tagIds: z.array(SessionOrganizationScopedIdSchema).max(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS).default([]),
    orderScopes: z.array(SessionOrganizationOrderScopeRequestSchema).max(SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS).default([]),
    includeAttentionStandings: z.boolean().default(false),
    includeAttentionReminderTimes: z.boolean().default(false),
  })
  .strict());
export type SessionOrganizationSnapshotRequest = z.infer<typeof SessionOrganizationSnapshotRequestSchema>;

export const SessionOrganizationSnapshotSchema = lazyZodSchema(() => z
  .object({
    schemaVersion: z.literal(SESSION_ORGANIZATION_SNAPSHOT_VERSION),
    version: z.number().int().nonnegative(),
    pins: z.array(SessionOrganizationPinSchema).max(SESSION_ORGANIZATION_MAX_PINNED_SESSIONS),
    folders: z.array(SessionOrganizationFolderSchema).max(SESSION_ORGANIZATION_MAX_FOLDERS),
    folderAssignments: z.array(SessionFolderAssignmentSchema),
    tags: z.array(SessionOrganizationTagSchema).max(SESSION_ORGANIZATION_MAX_TAGS),
    tagAssignments: z.array(SessionTagAssignmentSchema),
    orderEntries: z.array(SessionOrganizationOrderEntrySchema),
    labels: z.array(SessionOrganizationLabelSchema).max(SESSION_ORGANIZATION_MAX_LABELS),
    attentionStandings: z.array(SessionAttentionStandingSchema).optional(),
  })
  .strict());
export type SessionOrganizationSnapshot = z.infer<typeof SessionOrganizationSnapshotSchema>;

export const SessionOrganizationSnapshotResponseSchema = lazyZodSchema(() => z
  .object({
    snapshot: SessionOrganizationSnapshotSchema,
  })
  .strict());
export type SessionOrganizationSnapshotResponse = z.infer<typeof SessionOrganizationSnapshotResponseSchema>;
