import { z } from '../zodRuntimePolicy.js';

import {
  canonicalBoundedRecordKeySchema,
  canonicalBoundedStringSchema,
} from '../common/canonicalRecordKey.js';

export const ProviderConnectionIdSchema = canonicalBoundedRecordKeySchema(256).brand<'ProviderConnectionId'>();
export type ProviderConnectionId = z.infer<typeof ProviderConnectionIdSchema>;

export const ProviderContributionKeySchema = canonicalBoundedRecordKeySchema(512);
export type ProviderContributionKey = z.infer<typeof ProviderContributionKeySchema>;

export const ProviderLocalIdSchema = canonicalBoundedRecordKeySchema(128).check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u));

export const ProviderMachineIdSchema = canonicalBoundedRecordKeySchema(256);

export const ProviderAgentTargetKeySchema = canonicalBoundedRecordKeySchema(256);

export const ProviderModelIdSchema = canonicalBoundedStringSchema().check(z.refine((value) => !/\s/u.test(value), 'Model id must not contain whitespace'));
