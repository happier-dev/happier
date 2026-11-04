import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProviderLocalIdSchema, ProviderConnectionIdSchema } from '../ids.js';
import { ProviderWireProtocolSchema, ProviderCompatibilityCapabilitiesV1Schema, ProviderCompatibilityOverridesV1Schema } from '../capabilities/v1.js';
import { ProviderApiKeyCredentialRequirementV1Schema } from '../credentials/v1.js';
import { createProviderFingerprintV1 } from '../fingerprints.js';
import type { ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import { ProviderModelIdPatternV1Schema } from '../endpointPolicyV1.js';

/** Source declarations, never a transported Agent compatibility decision.
 * Endpoint addresses, headers, account/pool ids and credentials stay private. */
export const ProviderModelBindingSourceV1Schema = lazyZodSchema(() => z.strictObject({
  endpoint: z.strictObject({
    id: ProviderLocalIdSchema,
    protocol: ProviderWireProtocolSchema,
    capabilities: ProviderCompatibilityCapabilitiesV1Schema,
    modelIdPattern: z.optional(ProviderModelIdPatternV1Schema),
  }),
  credential: z.optional(ProviderApiKeyCredentialRequirementV1Schema),
  compatibilityOverrides: z.optional(ProviderCompatibilityOverridesV1Schema),
}));
export type ProviderModelBindingSourceV1 = z.infer<typeof ProviderModelBindingSourceV1Schema>;

/** A source can report an offered protocol/model without attesting an Agent
 * adapter. The recipient replaces this state with its own admission result. */
export function projectProviderModelSourceStateV1(sourceFacts: ProviderModelBindingSourceV1, model: ProviderModelDescriptorV1) {
  return { result: { status: 'experimental' as const, selectedProtocol: sourceFacts.endpoint.protocol,
    reasons: ['compatibility_evidence_missing' as const], confirmationScope: { kind: 'model' as const, modelId: model.id } },
    compatibilityFingerprint: createProviderFingerprintV1('compatibility', {
      source: JSON.stringify(sourceFacts), model: JSON.stringify(model),
    }), confirmed: false };
}

/** Opaque source scope used by the recipient's existing Account confirmation
 * writer. It does not grant access to the source or expose its private target. */
export const ProviderModelConfirmationSourceKeyV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)));
export const ProviderModelConfirmationSourceV1Schema = lazyZodSchema(() => z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  // SHA-256, unpadded base64url, from the confirmation source-key owner.
  catalogSourceKey: ProviderModelConfirmationSourceKeyV1Schema,
}));
