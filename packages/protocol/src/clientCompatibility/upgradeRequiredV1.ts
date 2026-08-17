import { z } from 'zod';

import { AccountStoredContentProtocolVersionSchema } from './accountStoredContentCompatibilityV1.js';

export const CLIENT_UPGRADE_REQUIRED_ERROR_CODE = 'client-upgrade-required' as const;
export const CLIENT_UPGRADE_REQUIRED_HTTP_STATUS = 426 as const;

export const AccountStoredContentUpgradeRequiredRequirementV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('account-stored-content'),
    minimumProtocolVersion: AccountStoredContentProtocolVersionSchema,
  })
  .strict();

export const AccountStoredContentUpgradeRequiredV1Schema = z
  .object({
    error: z.literal(CLIENT_UPGRADE_REQUIRED_ERROR_CODE),
    requirement: AccountStoredContentUpgradeRequiredRequirementV1Schema,
  })
  .strict();

export type AccountStoredContentUpgradeRequiredV1 = z.infer<
  typeof AccountStoredContentUpgradeRequiredV1Schema
>;

export const AnyClientUpgradeRequiredV1Schema =
  AccountStoredContentUpgradeRequiredV1Schema;

export type AnyClientUpgradeRequiredV1 = z.infer<
  typeof AnyClientUpgradeRequiredV1Schema
>;
