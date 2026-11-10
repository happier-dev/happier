import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ProviderAccountUsageQuotaScopeV1Schema = lazyZodSchema(() => z.enum([
  'account',
  'workspace',
  'organization',
  'project',
  'model',
  'provider',
  'unknown',
]));

export type ProviderAccountUsageQuotaScopeV1 = z.infer<
  typeof ProviderAccountUsageQuotaScopeV1Schema
>;
