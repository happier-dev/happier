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

export const SessionProviderBindingSecurityChangeConfirmationV1Schema = z.object({
  v: z.literal(1),
  sessionId: z.string().trim().min(1).max(256),
  connectionId: ProviderConnectionIdSchema,
  previousBindingSecurityFingerprint: z.string().trim().min(1).max(256),
  nextBindingSecurityFingerprint: z.string().trim().min(1).max(256),
}).strict();
export type SessionProviderBindingSecurityChangeConfirmationV1 = z.infer<
  typeof SessionProviderBindingSecurityChangeConfirmationV1Schema
>;

export const SESSION_PROVIDER_BINDING_METADATA_KEY_V1 = 'providerBindingV1' as const;

export function readSessionProviderBindingMetadataV1(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): SessionProviderBindingMetadataV1 | null {
  if (!metadata) return null;
  const parsed = SessionProviderBindingMetadataV1Schema.safeParse(
    metadata[SESSION_PROVIDER_BINDING_METADATA_KEY_V1],
  );
  return parsed.success ? parsed.data : null;
}

export function applySessionProviderBindingMetadataV1<T extends Readonly<Record<string, unknown>>>(
  metadata: T,
  binding: SessionProviderBindingMetadataV1 | null,
): T & Readonly<Record<string, unknown>> {
  const next = { ...metadata } as Record<string, unknown>;
  if (binding) {
    next[SESSION_PROVIDER_BINDING_METADATA_KEY_V1] = SessionProviderBindingMetadataV1Schema.parse(binding);
  } else {
    delete next[SESSION_PROVIDER_BINDING_METADATA_KEY_V1];
  }
  return next as T & Readonly<Record<string, unknown>>;
}
