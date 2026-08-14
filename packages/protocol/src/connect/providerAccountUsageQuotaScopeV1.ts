import { z } from 'zod';

export const ProviderAccountUsageQuotaScopeV1Schema = z.enum([
  'account',
  'workspace',
  'organization',
  'project',
  'model',
  'provider',
  'unknown',
]);

export type ProviderAccountUsageQuotaScopeV1 = z.infer<
  typeof ProviderAccountUsageQuotaScopeV1Schema
>;
