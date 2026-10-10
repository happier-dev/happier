import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AccountStoredContentProtocolVersionSchema } from './accountStoredContentCompatibilityV1.js';
import { SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION } from '../sessions/organization/constants.js';

export const CLIENT_UPGRADE_REQUIRED_ERROR_CODE = 'client-upgrade-required' as const;
export const CLIENT_UPGRADE_REQUIRED_HTTP_STATUS = 426 as const;

export const AccountStoredContentUpgradeRequiredRequirementV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    kind: z.literal('account-stored-content'),
    minimumProtocolVersion: AccountStoredContentProtocolVersionSchema,
  })
  .strict());

export const AccountStoredContentUpgradeRequiredV1Schema = lazyZodSchema(() => z
  .object({
    error: z.literal(CLIENT_UPGRADE_REQUIRED_ERROR_CODE),
    requirement: AccountStoredContentUpgradeRequiredRequirementV1Schema,
  })
  .strict());

export type AccountStoredContentUpgradeRequiredV1 = z.infer<
  typeof AccountStoredContentUpgradeRequiredV1Schema
>;

export const SessionOrganizationUpgradeRequiredV1Schema = lazyZodSchema(() => z.object({
  error: z.literal(CLIENT_UPGRADE_REQUIRED_ERROR_CODE),
  requirement: z.object({
    v: z.literal(1),
    kind: z.literal('session-organization'),
    minimumProtocolVersion: z.literal(SESSION_ORGANIZATION_CURRENT_PROJECTION_VERSION),
  }).strict(),
}).strict());

export const AnyClientUpgradeRequiredV1Schema = lazyZodSchema(() => z.union([
  AccountStoredContentUpgradeRequiredV1Schema,
  SessionOrganizationUpgradeRequiredV1Schema,
]));

export type AnyClientUpgradeRequiredV1 = z.infer<
  typeof AnyClientUpgradeRequiredV1Schema
>;
