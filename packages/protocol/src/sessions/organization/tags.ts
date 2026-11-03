import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { QualifiedSessionSpaceTagV1Schema } from '../../collections/spaces/collectionSpacesV1.js';

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

const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationTagIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationTagKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_KEY_LENGTH)));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH)));

/** Private presentation identity inside the existing Account content envelope. */
export const SessionSpaceMembershipTagDisplayV1Schema = lazyZodSchema(() => z.object({
    kind: z.literal('space_membership'),
    spaceId: z.string().check(z.trim(), z.minLength(1)),
    spaceSettingsTarget: z.omit(QualifiedSessionSpaceTagV1Schema, { tagId: true }),
}));
export type SessionSpaceMembershipTagDisplayV1 = z.infer<typeof SessionSpaceMembershipTagDisplayV1Schema>;

export function readSessionSpaceMembershipTagDisplayV1(value: unknown): SessionSpaceMembershipTagDisplayV1 | null {
    const parsed = SessionSpaceMembershipTagDisplayV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export const SessionOrganizationTagSchema = lazyZodSchema(() => z.strictObject({
    tagId: SessionOrganizationTagIdSchema,
    tagKey: SessionOrganizationTagKeySchema,
    sortKey: z.nullable(SessionOrganizationSortKeySchema),
    display: z.nullable(SessionOrganizationContentEnvelopeSchema),
    displayState: z.optional(SessionOrganizationDisplayStateSchema),
    archivedAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type SessionOrganizationTag = z.infer<typeof SessionOrganizationTagSchema>;

export const SessionTagAssignmentSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationSessionIdSchema,
    tagIds: z.array(SessionOrganizationTagIdSchema).check(z.maxLength(SESSION_ORGANIZATION_MAX_TAGS)),
  }));
export type SessionTagAssignment = z.infer<typeof SessionTagAssignmentSchema>;
