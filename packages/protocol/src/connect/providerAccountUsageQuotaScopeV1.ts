import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

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
