import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';

import {
  SESSION_ORGANIZATION_MAX_ID_LENGTH,
  SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
} from './constants.js';

const SessionOrganizationSessionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));
const SessionOrganizationSortKeySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH)));

const SessionOrganizationPinFieldsSchema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionOrganizationSessionIdSchema,
    sortKey: z.nullable(SessionOrganizationSortKeySchema),
    pinnedAt: z.number().check(z.int(), z.nonnegative()),
    listPinned: z.boolean(),
    railPinned: z.boolean(),
  }));
const hasPinMembership = (pin: Readonly<{ listPinned: boolean; railPinned: boolean }>) => pin.listPinned || pin.railPinned;

export const SessionOrganizationPinSchema = defineStoredReadProjection(
  lazyZodSchema(() => SessionOrganizationPinFieldsSchema.check(z.refine(hasPinMembership))),
  // The retained 0.2 row has neither flag and represents only a Session-list pin.
  () => lazyZodSchema(() => z.extend(createStoredReadSchema(SessionOrganizationPinFieldsSchema), {
    listPinned: z._default(z.boolean(), true),
    railPinned: z._default(z.boolean(), false),
  }).check(z.refine(hasPinMembership))),
);
export type SessionOrganizationPin = z.infer<typeof SessionOrganizationPinSchema>;
export const SessionOrganizationPinStoredSchema = createStoredReadSchema(SessionOrganizationPinSchema);
export const SessionOrganizationPinSurfaceSchema = lazyZodSchema(() => z.enum(['list', 'rail']));
export type SessionOrganizationPinSurface = z.infer<typeof SessionOrganizationPinSurfaceSchema>;

export const SESSION_ORGANIZATION_PIN_HTTP_PATH_V1 = '/v2/session-organization/pins/:sessionId';
export function buildSessionOrganizationPinHttpPathV1(sessionId: string): string {
  return SESSION_ORGANIZATION_PIN_HTTP_PATH_V1.replace(':sessionId', encodeURIComponent(sessionId));
}
