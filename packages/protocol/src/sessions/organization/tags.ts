import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
  SESSION_ORGANIZATION_MAX_TAGS,
} from './constants.js';
import {
  SessionOrganizationContentEnvelopeSchema,
  SessionOrganizationDisplayStateSchema,
} from './contentSchemas.js';

const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));
const SessionOrganizationTagIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));
const SessionOrganizationTagKeySchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_KEY_LENGTH));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH));

export const SessionOrganizationTagSchema = lazyZodSchema(() => z
  .object({
    tagId: SessionOrganizationTagIdSchema,
    tagKey: SessionOrganizationTagKeySchema,
    sortKey: SessionOrganizationSortKeySchema.nullable(),
    display: SessionOrganizationContentEnvelopeSchema.nullable(),
    displayState: SessionOrganizationDisplayStateSchema.optional(),
    archivedAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionOrganizationTag = z.infer<typeof SessionOrganizationTagSchema>;

export const SessionTagAssignmentSchema = lazyZodSchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    tagIds: z.array(SessionOrganizationTagIdSchema).max(SESSION_ORGANIZATION_MAX_TAGS),
  })
  .strict());
export type SessionTagAssignment = z.infer<typeof SessionTagAssignmentSchema>;
