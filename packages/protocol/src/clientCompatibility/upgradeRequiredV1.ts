import { z } from 'zod';

import {
  ClientAppVersionSchema,
  ClientKindSchema,
  SafeHttpsUrlSchema,
} from './primitives.js';
import { lazySchema } from '../lazySchema.js';

export const CLIENT_UPGRADE_REQUIRED_ERROR_CODE = 'client-upgrade-required' as const;
export const CLIENT_UPGRADE_REQUIRED_HTTP_STATUS = 426 as const;

export const ClientUpgradeRequiredRequirementV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1),
    clientKind: ClientKindSchema.nullable(),
    minimumAppVersion: ClientAppVersionSchema.nullable(),
    updateUrl: SafeHttpsUrlSchema.nullable(),
  })
  .strict());

export const ClientUpgradeRequiredV1Schema = lazySchema(() => z
  .object({
    error: z.literal(CLIENT_UPGRADE_REQUIRED_ERROR_CODE),
    requirement: ClientUpgradeRequiredRequirementV1Schema,
  })
  .strict());

export type ClientUpgradeRequiredV1 = z.infer<typeof ClientUpgradeRequiredV1Schema>;
