import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { generateKeyBetween } from 'fractional-indexing';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
} from './constants.js';
import {
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationDisplayStateSchema,
} from './contentSchemas.js';

const SessionOrganizationFolderIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationFolderKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_KEY_LENGTH)));
const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH)));

/** Account-level section identity; assignments keep the same Home-local folder id. */
export const QualifiedSessionSectionV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)),
  sectionId: SessionOrganizationFolderIdSchema,
}));
export type QualifiedSessionSectionV1 = z.infer<typeof QualifiedSessionSectionV1Schema>;

export const SessionOrganizationLockedReasonV1Schema = lazyZodSchema(() => z.enum([
  'account_key_unavailable', 'content_unreadable', 'invalid_stored_display', 'storage_mode_mismatch',
]));
export type SessionOrganizationLockedReasonV1 = z.infer<typeof SessionOrganizationLockedReasonV1Schema>;

export const SessionSectionDisplayV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string().check(z.trim(), z.minLength(1)),
  icon: z.nullable(z.string().check(z.trim(), z.minLength(1))),
}));
export type SessionSectionDisplayV1 = z.infer<typeof SessionSectionDisplayV1Schema>;

export const SessionSectionDisplayStateV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), value: SessionSectionDisplayV1Schema }),
  z.strictObject({ status: z.literal('locked'), reason: SessionOrganizationLockedReasonV1Schema }),
]));
export type SessionSectionDisplayStateV1 = z.infer<typeof SessionSectionDisplayStateV1Schema>;

export const SessionSectionV1Schema = lazyZodSchema(() => z.strictObject({
  sectionId: SessionOrganizationFolderIdSchema,
  displayState: SessionSectionDisplayStateV1Schema,
  sortKey: z.nullable(SessionOrganizationSortKeySchema),
}));
export type SessionSectionV1 = z.infer<typeof SessionSectionV1Schema>;

export function compareSessionSectionOrderV1(
  left: Pick<SessionSectionV1, 'sectionId' | 'sortKey'>,
  right: Pick<SessionSectionV1, 'sectionId' | 'sortKey'>,
): number {
  if (left.sortKey === null && right.sortKey !== null) return 1;
  if (left.sortKey !== null && right.sortKey === null) return -1;
  if (left.sortKey !== right.sortKey) return (left.sortKey ?? '') < (right.sortKey ?? '') ? -1 : 1;
  return left.sectionId.localeCompare(right.sectionId);
}

/** The fresh key and its next neighbor in the canonical Section order; retained rows are never repaired. */
export function resolveSessionSectionCreatePlacementV1(
  sections: readonly Pick<SessionSectionV1, 'sectionId' | 'sortKey'>[],
): Readonly<{ sortKey: string; beforeSectionId: string | null }> {
  let lastValid: Pick<SessionSectionV1, 'sectionId' | 'sortKey'> | null = null;
  let sortKey = generateKeyBetween(null, null);
  for (const section of sections) {
    if (section.sortKey === null || lastValid && compareSessionSectionOrderV1(section, lastValid) <= 0) continue;
    try {
      sortKey = generateKeyBetween(section.sortKey, null);
      lastValid = section;
    } catch {
      // Null/padded/invalid legacy keys remain untouched; only explicit reorder repairs them.
    }
  }
  // The generated key cannot equal a retained valid key, so the placeholder id
  // never participates in the comparator's equal-key identity tie-break.
  const created = { sectionId: '', sortKey };
  let before: Pick<SessionSectionV1, 'sectionId' | 'sortKey'> | null = null;
  for (const section of sections) {
    const direction = compareSessionSectionOrderV1(section, created);
    if (direction > 0 && (!before || compareSessionSectionOrderV1(section, before) < 0)) before = section;
  }
  return { sortKey, beforeSectionId: before?.sectionId ?? null };
}

export type SessionOrganizationOpenedDisplayStateV1 = Readonly<
  | { status: 'available'; value: unknown }
  | { status: 'locked'; reason: SessionOrganizationLockedReasonV1 }
>;

/** Read retained 0.2 names/workspace displays without rewriting private content. */
export function readSessionSectionDisplayV1(
  state: SessionOrganizationOpenedDisplayStateV1,
  display?: z.infer<typeof SessionOrganizationContentEnvelopeSchema> | null,
): SessionSectionDisplayStateV1 {
  if (state.status === 'locked') return state;
  const value = state.value ?? (display?.t === 'plain' ? display.v : null);
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
  const parsed = SessionSectionDisplayV1Schema.safeParse({
    name: typeof value === 'string' ? value : record?.name,
    icon: record?.icon ?? null,
  });
  return parsed.success ? { status: 'available', value: parsed.data }
    : { status: 'locked', reason: 'invalid_stored_display' };
}

export function projectSessionSectionV1(folder: Readonly<{
  folderId: string;
  sortKey: string | null;
  displayState: SessionOrganizationOpenedDisplayStateV1;
  display?: z.infer<typeof SessionOrganizationContentEnvelopeSchema> | null;
}>): SessionSectionV1 {
  return { sectionId: folder.folderId, sortKey: folder.sortKey,
    displayState: readSessionSectionDisplayV1(folder.displayState, folder.display) };
}

export const SessionOrganizationFolderSchema = lazyZodSchema(() => z.strictObject({
    folderId: SessionOrganizationFolderIdSchema,
    folderKey: SessionOrganizationFolderKeySchema,
    parentFolderId: z.nullable(SessionOrganizationFolderIdSchema),
    parentFolderKey: z.nullable(SessionOrganizationFolderKeySchema),
    sortKey: z.nullable(SessionOrganizationSortKeySchema),
    display: z.nullable(SessionOrganizationContentEnvelopeSchema),
    displayState: z.optional(SessionOrganizationDisplayStateSchema),
    archivedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionOrganizationFolder = z.infer<typeof SessionOrganizationFolderSchema>;

export const SessionFolderAssignmentSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationSessionIdSchema,
    folderId: SessionOrganizationFolderIdSchema,
  }));
export type SessionFolderAssignment = z.infer<typeof SessionFolderAssignmentSchema>;

export const SessionFolderAssignmentMutationResultSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationSessionIdSchema,
    folderId: z.nullable(SessionOrganizationFolderIdSchema),
  }));
export type SessionFolderAssignmentMutationResult = z.infer<typeof SessionFolderAssignmentMutationResultSchema>;
