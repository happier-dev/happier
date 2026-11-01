import { z } from 'zod';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
} from './constants.js';
import { lazySchema } from '../lazySchema.js';

const SessionOrganizationSessionIdSchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));
const SessionOrganizationSortKeySchema = lazySchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH));

export const SessionOrganizationPinSchema = lazySchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    sortKey: SessionOrganizationSortKeySchema.nullable(),
    pinnedAt: z.number().int().nonnegative(),
  })
  .strict());
export type SessionOrganizationPin = z.infer<typeof SessionOrganizationPinSchema>;
