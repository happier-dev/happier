import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProviderAgentTargetKeySchema, ProviderModelIdSchema } from '../../providers/ids.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import { ProviderBrokerApplicationBindingV1Schema } from '../../providers/brokerRouteGrantV1.js';
import { ProviderModelBindingSourceV1Schema } from '../../providers/compatibility/sourceFacts.js';
import { ProviderBindingCompatibilityV1Schema } from '../../providers/compatibility/v1.js';
import { ProviderCompatibilityFingerprintV1Schema } from '../../providers/fingerprints.js';
import { ProviderMergedCatalogRowV1Schema } from '../../providers/catalog/merge.js';
import { TeamCredentialRouteV1Schema } from './deliveryV1.js';
import { SessionTeamCredentialNativeDeliveryV1Schema } from './sessionBindingIntentV1.js';
import { ProviderErrorCodeV1Schema } from '../../providers/errors.js';

/** Least-privilege selection; source and administration authority stay private. */
export const TeamCredentialProviderModelSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('team_credential_provider_model'),
  resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
  teamId: z.string().check(z.minLength(1)),
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
  deliveryMode: TeamCredentialRouteV1Schema,
  nativeDelivery: z.optional(SessionTeamCredentialNativeDeliveryV1Schema),
}).check(z.superRefine((selection, context) => {
  if (selection.nativeDelivery && selection.deliveryMode !== 'vendor-native') {
    context.addIssue({ code: 'custom', path: ['nativeDelivery'], message: 'Native references require native delivery' });
  }
})));

export const TeamCredentialProviderModelCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  selection: TeamCredentialProviderModelSelectionV1Schema,
  descriptor: ProviderModelDescriptorV1Schema,
  /** Exact source-owned application capable of serving this model. */
  application: ProviderBrokerApplicationBindingV1Schema,
  sourceFacts: z.optional(ProviderModelBindingSourceV1Schema),
  /** Catalog evidence is presentation, independent of route readiness or consent.
   * Older producers omit these facts; absence never implies verification. */
  sources: z.optional(ProviderMergedCatalogRowV1Schema.shape.sources),
  confidence: z.optional(ProviderMergedCatalogRowV1Schema.shape.confidence),
  /** Source-reported state is presentation only; the worker derives admission. */
  compatibility: z.optional(z.strictObject({
    result: ProviderBindingCompatibilityV1Schema,
    compatibilityFingerprint: ProviderCompatibilityFingerprintV1Schema,
    confirmed: z.boolean(),
  })),
  /** Opaque current source/catalog identity. It contains no source-private data. */
  sourceRevision: z.string().check(z.minLength(1), z.maxLength(512)),
  nativeSource: z.optional(z.strictObject({
    providerTicket: SessionTeamCredentialNativeDeliveryV1Schema.shape.providerTicket,
  })),
  /** Opaque recipient-safe witness for current private direct material. */
  direct: z.optional(z.nullable(z.strictObject({
    sourceMemberKey: z.string().check(z.minLength(1), z.maxLength(512)),
    sourceVersion: z.string().check(z.minLength(1), z.maxLength(512)),
  }))),
  availability: z.enum(['available', 'source_owner_required', 'resource_corrupt', 'policy_denied']),
  /** Exact worker/custodian refusal for this presentation, never install authority. */
  deliveryUnavailableReason: z.optional(ProviderErrorCodeV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.selection.modelId !== value.descriptor.id) {
    context.addIssue({ code: 'custom', path: ['descriptor', 'id'], message: 'Descriptor must identify the selected canonical model' });
  }
  if (value.selection.agentTargetKey !== value.application.agentTargetKey) {
    context.addIssue({ code: 'custom', path: ['application', 'agentTargetKey'], message: 'Application must target the selected Agent' });
  }
})));

export type TeamCredentialProviderModelSelectionV1 = z.infer<typeof TeamCredentialProviderModelSelectionV1Schema>;
export type TeamCredentialProviderModelCatalogEntryV1 = z.infer<typeof TeamCredentialProviderModelCatalogEntryV1Schema>;
