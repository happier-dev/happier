import { z } from '../zodRuntimePolicy.js';
import { PluginUiReleaseSlotV1Schema } from '../plugins/availability/v1.js';
import { PackageAssetArchiveDescriptorV1Schema } from '../plugins/availability/packageAssetV1.js';
import { StoredReviewCommentV1Schema, BoundReviewCommentEventSensitiveEnvelopeV1Schema } from '../reviews/comments/content.js';
import { ReviewCommentEventV1Schema } from '../reviews/comments/v1.js';
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import { ReviewVerdictContentV1Schema } from '../reviews/reviewHumanV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationStoredContentEnvelopeV1Schema } from '../automations/automationStoredContentEnvelopeV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from '../automations/automationTriggerIdentity.js';

/** Workflow-keyed Action definitions follow the Artifact, regardless of author. */
export const ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema = z.array(z.strictObject({
  automationId: z.string().check(z.minLength(1)),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  content: AutomationStoredContentEnvelopeV1Schema,
}));
export type ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1 = z.infer<typeof ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema>;
export const ArtifactActionTriggerDefinitionsAccountEncryptionMigrationReplacementV1Schema = z.strictObject({
  expected: ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema,
  target: ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema,
});

/** Resource-keyed content follows the Artifact owner, including other authors. */
export const ArtifactReviewGraphAccountEncryptionMigrationV1Schema = lazyZodSchema(() => z.strictObject({
  comments: z.array(z.strictObject({
    stored: StoredReviewCommentV1Schema,
    events: z.array(z.strictObject({ event: ReviewCommentEventV1Schema, sensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1Schema })),
  })),
  verdicts: z.array(z.strictObject({
    ...z.omit(ReviewVerdictContentV1Schema, { body: true }).shape,
    content: z.nullable(StoredJsonContentEnvelopeSchema),
  })),
}));
export type ArtifactReviewGraphAccountEncryptionMigrationV1 = z.infer<typeof ArtifactReviewGraphAccountEncryptionMigrationV1Schema>;
export const ArtifactReviewGraphAccountEncryptionMigrationReplacementV1Schema = z.strictObject({
  expected: ArtifactReviewGraphAccountEncryptionMigrationV1Schema,
  target: ArtifactReviewGraphAccountEncryptionMigrationV1Schema,
});

/** Account-transition inventory V1: authority and content envelopes are closed. */
export const ArtifactAccountEncryptionMigrationOwnershipV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ordinary') }),
  z.strictObject({ kind: z.literal('pluginUi'), pluginId: z.string().check(z.minLength(1)), slot: PluginUiReleaseSlotV1Schema }),
  z.strictObject({ kind: z.literal('packageAsset'), pluginId: z.string().check(z.minLength(1)), descriptor: PackageAssetArchiveDescriptorV1Schema }),
]);
export type ArtifactAccountEncryptionMigrationOwnershipV1 = z.infer<typeof ArtifactAccountEncryptionMigrationOwnershipV1Schema>;

export const ArtifactAccountEncryptionMigrationRowV1Schema = z.strictObject({
  id: z.string().check(z.minLength(1)), ownership: ArtifactAccountEncryptionMigrationOwnershipV1Schema,
  publicAudience: z.enum(['retained', 'none']),
  header: z.string().check(z.minLength(1)), headerVersion: z.number().check(z.int(), z.nonnegative()),
  body: z.string().check(z.minLength(1)), bodyVersion: z.number().check(z.int(), z.nonnegative()), dataEncryptionKey: z.string().check(z.minLength(1)),
  provenance: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  provenanceDataEncryptionKey: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  reviewGraph: z.optional(ArtifactReviewGraphAccountEncryptionMigrationV1Schema),
  actionTriggerDefinitions: z.optional(ArtifactActionTriggerDefinitionsAccountEncryptionMigrationV1Schema),
  revisions: z.array(z.strictObject({ bodyVersion: z.number().check(z.int(), z.nonnegative()), body: z.string().check(z.minLength(1)),
    provenance: z.optional(z.nullable(z.string().check(z.minLength(1)))) })),
});
export const ArtifactAccountEncryptionMigrationInventoryV1Schema = z.strictObject({
  ownerAccountId: z.string().check(z.minLength(1)), encryptionMode: z.enum(['plain', 'e2ee']),
  items: z.array(ArtifactAccountEncryptionMigrationRowV1Schema), nextCursor: z.nullable(z.string().check(z.minLength(1))),
});
export type ArtifactAccountEncryptionMigrationInventoryV1 = z.infer<typeof ArtifactAccountEncryptionMigrationInventoryV1Schema>;
