import { z } from 'zod';

import { ProviderWireProtocolSchema } from '../capabilities/v1.js';
import { ProviderConnectionIdSchema, ProviderContributionKeySchema } from '../ids.js';
import { ProviderAdapterBindingKeyV1Schema } from './adapterBindingKeyV1.js';

export const SessionProviderBindingMetadataV1Schema = z.object({
  v: z.literal(1),
  connectionId: ProviderConnectionIdSchema,
  contributionKey: ProviderContributionKeySchema.nullable(),
  connectionRevision: z.number().int().nonnegative(),
  protocol: ProviderWireProtocolSchema,
  materialization: z.enum(['spawnEnv', 'engineConfig', 'configFile']),
  adapterBindingKey: ProviderAdapterBindingKeyV1Schema.optional(),
  compatibilityFingerprint: z.string().trim().min(1).max(256),
  bindingSecurityFingerprint: z.string().trim().min(1).max(256),
  displaySnapshot: z.object({
    providerName: z.string().trim().min(1).max(128),
    connectionName: z.string().trim().min(1).max(128),
    connectionRole: z.enum(['default', 'named']),
    connectionDisplayNameMode: z.enum(['automatic', 'custom']),
  }).strict(),
}).strict();
export type SessionProviderBindingMetadataV1 = z.infer<typeof SessionProviderBindingMetadataV1Schema>;
