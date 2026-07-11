import { z } from 'zod';

import { ProviderHttpsUrlSchema } from '../httpsUrlSchema.js';
import { ProviderAgentTargetKeySchema } from '../ids.js';

export const ProviderWireProtocolSchema = z.enum([
  'anthropic',
  'openai-chat',
  'openai-responses',
  'ollama-native',
]);
export type ProviderWireProtocol = z.infer<typeof ProviderWireProtocolSchema>;

export const CapabilitySupportSchema = z.enum(['supported', 'unsupported', 'unknown']);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

export const ProviderCompatibilityCapabilitiesV1Schema = z.object({
  streaming: CapabilitySupportSchema,
  toolRoundTrips: CapabilitySupportSchema,
  statefulResponses: CapabilitySupportSchema,
  reasoningControls: CapabilitySupportSchema,
}).strict();
export type ProviderCompatibilityCapabilitiesV1 = z.infer<typeof ProviderCompatibilityCapabilitiesV1Schema>;

export const PROVIDER_CAPABILITY_KEYS = [
  'streaming',
  'toolRoundTrips',
  'statefulResponses',
  'reasoningControls',
] as const satisfies readonly (keyof ProviderCompatibilityCapabilitiesV1)[];

export const ProviderCompatibilityEvidenceV1Schema = z.object({
  sourceUrls: z.array(ProviderHttpsUrlSchema).min(1).max(16),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  providerVersion: z.string().trim().min(1).max(128).optional(),
  agentVersion: z.string().trim().min(1).max(128).optional(),
  testIds: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
}).strict();
export type ProviderCompatibilityEvidenceV1 = z.infer<typeof ProviderCompatibilityEvidenceV1Schema>;

export const ProviderCompatibilityOverrideV1Schema = z.object({
  agentTargetKey: ProviderAgentTargetKeySchema,
  protocol: ProviderWireProtocolSchema,
  status: z.enum(['verified', 'experimental', 'incompatible']),
  reason: z.string().trim().min(1).max(1024),
  evidence: ProviderCompatibilityEvidenceV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'verified' && !value.evidence) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'Verified compatibility requires evidence' });
  }
});
export type ProviderCompatibilityOverrideV1 = z.infer<typeof ProviderCompatibilityOverrideV1Schema>;

export const ProviderCompatibilityOverridesV1Schema = z.array(ProviderCompatibilityOverrideV1Schema)
  .max(128)
  .superRefine((overrides, ctx) => {
    const keys = new Set<string>();
    overrides.forEach((override, index) => {
      const key = JSON.stringify([override.agentTargetKey, override.protocol]);
      if (keys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'Compatibility overrides must be unique by agent target and protocol',
        });
      }
      keys.add(key);
    });
  });
