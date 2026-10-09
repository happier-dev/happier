import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
} from './constants.js';

const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_ID_LENGTH));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().trim().min(1).max(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH));

const SessionOrganizationPinFieldsSchema = lazyZodSchema(() => z
  .object({
    sessionId: SessionOrganizationSessionIdSchema,
    sortKey: SessionOrganizationSortKeySchema.nullable(),
    pinnedAt: z.number().int().nonnegative(),
    listPinned: z.boolean(),
    railPinned: z.boolean(),
  })
  .strict());
const hasPinMembership = (pin: Readonly<{ listPinned: boolean; railPinned: boolean }>) => pin.listPinned || pin.railPinned;

export const SessionOrganizationPinSchema = defineStoredReadProjection(
  lazyZodSchema(() => SessionOrganizationPinFieldsSchema.refine(hasPinMembership)),
  // The retained 0.2 row has neither flag and represents only a Session-list pin.
  () => createStoredReadSchema(SessionOrganizationPinFieldsSchema).extend({
    listPinned: z.boolean().default(true),
    railPinned: z.boolean().default(false),
  }).refine(hasPinMembership),
);
export type SessionOrganizationPin = z.infer<typeof SessionOrganizationPinSchema>;
export const SessionOrganizationPinStoredSchema = createStoredReadSchema(SessionOrganizationPinSchema);
export const SessionOrganizationPinSurfaceSchema = lazyZodSchema(() => z.enum(['list', 'rail']));
export type SessionOrganizationPinSurface = z.infer<typeof SessionOrganizationPinSurfaceSchema>;

export const SESSION_ORGANIZATION_PIN_HTTP_PATH_V1 = '/v2/session-organization/pins/:sessionId';
export function buildSessionOrganizationPinHttpPathV1(sessionId: string): string {
  return SESSION_ORGANIZATION_PIN_HTTP_PATH_V1.replace(':sessionId', encodeURIComponent(sessionId));
}
