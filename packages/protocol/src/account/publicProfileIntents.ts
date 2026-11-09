import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageQuerySchema } from '../inputs/usageQuery.js';
import { WidgetAreaLayoutV1Schema } from '../widgets/widgetSurfaceArtifactV1.js';
import { ScmCredentialFreeRepositorySelectorV1Schema } from '../scm/repositoryClone.js';
import { PublicProfileMetadataV1Schema, PublicProfilePolicyV1Schema } from './publicProfile.js';
import { PublicProfilePublishBodyV1Schema, PublicProfileUpdateBodyV1Schema,
  PublicProfileLocalPreviewViewV1Schema, PublicProfileMutationResultV1Schema, PublicProfileUnavailableReasonV1Schema } from './publicProfilePublication.js';
export { PublicProfileLocalPreviewViewV1Schema, type PublicProfileLocalPreviewViewV1 } from './publicProfilePublication.js';

/** Repository publicity is observed by the host, never asserted in an Action input. */
export const PublicProfileMetadataSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.omit(PublicProfileMetadataV1Schema, { projects: true }).shape,
  projectSelections: z.optional(z.array(ScmCredentialFreeRepositorySelectorV1Schema)),
}));
export type PublicProfileMetadataSelectionV1 = z.infer<typeof PublicProfileMetadataSelectionV1Schema>;

// Private Action input only. Prepared HTTP effects and stored editions remain inert inline layouts;
// the inline arm also keeps acknowledged editions usable by Undo.
const PublicProfileLayoutSelectionV1Schema = lazyZodSchema(() => z.union([
  PublicProfilePublishBodyV1Schema.shape.layout, WidgetAreaLayoutV1Schema,
]));

export const PublicProfilePreviewIntentV1Schema = lazyZodSchema(() => z.strictObject({
  policy: PublicProfilePolicyV1Schema,
  metadataSelection: PublicProfileMetadataSelectionV1Schema,
  query: UsageQuerySchema,
  layout: PublicProfileLayoutSelectionV1Schema,
  appearance: PublicProfilePublishBodyV1Schema.shape.appearance,
}));
export type PublicProfilePreviewIntentV1 = z.infer<typeof PublicProfilePreviewIntentV1Schema>;
export const PublicProfilePublishIntentV1Schema = lazyZodSchema(() => z.strictObject({
  ...PublicProfilePreviewIntentV1Schema.shape, intent: z.literal('publish'),
}));
export type PublicProfilePublishIntentV1 = z.infer<typeof PublicProfilePublishIntentV1Schema>;
export const PublicProfileUpdateIntentV1Schema = lazyZodSchema(() => z.strictObject({
  policy: z.optional(PublicProfilePolicyV1Schema),
  metadataSelection: z.optional(PublicProfileMetadataSelectionV1Schema),
  query: z.optional(UsageQuerySchema),
  layout: z.optional(PublicProfileLayoutSelectionV1Schema),
  appearance: PublicProfileUpdateBodyV1Schema.shape.appearance,
}).check(z.refine(value => Object.values(value).some(member => member !== undefined))));
export type PublicProfileUpdateIntentV1 = z.infer<typeof PublicProfileUpdateIntentV1Schema>;

export const PublicProfileSnapshotUnavailableReasonV1Schema = z.enum([
  'usage_unavailable', 'query_mismatch', 'period_unavailable', 'source_time_unavailable', 'no_eligible_personal_usage', 'invalid_snapshot',
]);
export type PublicProfileSnapshotUnavailableReasonV1 = z.infer<typeof PublicProfileSnapshotUnavailableReasonV1Schema>;

// Lazy: publicProfilePublication participates in an import cycle with the widget
// snapshot schema, so its enum options are not readable at module evaluation.
export const PublicProfilePreparationUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  ...PublicProfileUnavailableReasonV1Schema.options, ...PublicProfileSnapshotUnavailableReasonV1Schema.options, 'usage_query_result_invalid',
  'project_visibility_unavailable', 'preparation_unavailable',
]));
export type PublicProfilePreparationUnavailableReasonV1 = z.infer<typeof PublicProfilePreparationUnavailableReasonV1Schema>;
export const PublicProfilePreviewResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), view: PublicProfileLocalPreviewViewV1Schema }),
  z.strictObject({ kind: z.literal('unavailable'), reason: PublicProfilePreparationUnavailableReasonV1Schema }),
]));
export const PublicProfileUpdateResultV1Schema = PublicProfileMutationResultV1Schema;
