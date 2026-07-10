import { z } from 'zod';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
} from './constants.js';

const SessionOrganizationSessionIdSchema = z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH);
const SessionOrganizationSortKeySchema = z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH);

export const SessionOrganizationPinSchema = z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    sortKey: SessionOrganizationSortKeySchema.nullable(),
    pinnedAt: z.number().int().nonnegative(),
  })
  .strict();
export type SessionOrganizationPin = z.infer<typeof SessionOrganizationPinSchema>;
