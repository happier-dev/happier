import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { TeamCredentialResourceReadinessV1 } from './resourceReadinessV1.js';

/** Comparison-only references; raw placeholder and source ticket stay private. */
export const SessionTeamCredentialNativeDeliveryV1Schema = lazyZodSchema(() => z.strictObject({
  managedId: z.string().check(z.minLength(1)),
  controllerInstallationId: z.string().check(z.minLength(1)),
  guestInstallationId: z.string().check(z.minLength(1)),
  bindingKey: z.string().check(z.minLength(1)),
  placeholderRef: z.string().check(z.minLength(1)),
  sourceRevision: z.string().check(z.minLength(1), z.maxLength(512)),
  providerTicket: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export type SessionTeamCredentialNativeDeliveryV1 = z.infer<typeof SessionTeamCredentialNativeDeliveryV1Schema>;

/** Recipient paths, distinct from the administration-only delivery union. */
export const TEAM_CREDENTIAL_ROUTES_V1 = ['brokered', 'direct', 'vendor-native'] as const;
export const TeamCredentialRouteV1Schema = lazyZodSchema(() => z.enum(TEAM_CREDENTIAL_ROUTES_V1));
export type TeamCredentialRouteV1 = z.infer<typeof TeamCredentialRouteV1Schema>;

export const TeamCredentialAllowedRoutesV1Schema = lazyZodSchema(() => z.array(TeamCredentialRouteV1Schema)
  .check(z.minLength(1), z.superRefine((routes, context) => {
    if (new Set(routes).size !== routes.length) context.addIssue({ code: 'custom', message: 'Routes must be unique' });
  })));
export type TeamCredentialAllowedRoutesV1 = z.infer<typeof TeamCredentialAllowedRoutesV1Schema>;

/** Ordered intentional custodian allowance; audience entitlement is separate. */
export const TeamCredentialDeliveryPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  preferredAllowedModes: TeamCredentialAllowedRoutesV1Schema,
}));
export type TeamCredentialDeliveryPolicyV1 = z.infer<typeof TeamCredentialDeliveryPolicyV1Schema>;

export const TeamCredentialDeliveryConfigurationV1Schema = lazyZodSchema(() => z.strictObject({
  policy: TeamCredentialDeliveryPolicyV1Schema,
}));
export type TeamCredentialDeliveryConfigurationV1 = z.infer<typeof TeamCredentialDeliveryConfigurationV1Schema>;

/** Brokered allowances do not govern Direct delivery; all other refusals remain. */
export function readTeamCredentialDeliveryReadinessV1(
  readiness: TeamCredentialResourceReadinessV1,
  deliveryMode: TeamCredentialRouteV1,
): TeamCredentialResourceReadinessV1 {
  return deliveryMode !== 'brokered' && readiness.kind === 'limit_reached'
    ? { kind: 'available' } : readiness;
}
