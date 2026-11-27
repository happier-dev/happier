import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageQuerySchema, UsageRelativePeriodSchema } from '../inputs/usageQuery.js';
import { ScmCredentialFreeRepositorySelectorV1Schema } from '../scm/repositoryClone.js';
import { WidgetSnapshotDocumentV1Schema } from '../sessions/board/declarative/snapshot.js';
import { WidgetGridSizeV1Schema, WidgetGroupWidthV1Schema } from '../widgets/widgetPresentationV1.js';
import { PublicProfileLayoutV1Schema } from '../widgets/widgetPublicSnapshotV1.js';
import { BuiltinUsagePublicPresentationV1Schema } from '../widgets/builtinWidgetDescriptorV1.js';
import { WidgetInstanceV1Schema } from '../widgets/widgetInstanceV1.js';
import { PublicProfileAtmosphereV1Schema, PublicProfilePreparedAtmosphereV1Schema } from './publicProfileAtmosphere.js';
import { PublicProfileIdentityV1Schema, PublicProfileLinkV1Schema,
  PublicProfileMetadataV1Schema, PublicProfilePolicyV1Schema, PublicProfileSnapshotV1Schema } from './publicProfile.js';
import { normalizePublicProfileReportUrlV1 } from './publicProfileReportUrl.js';

export { PublicProfileLayoutV1Schema } from '../widgets/widgetPublicSnapshotV1.js';
export type { PublicProfileLayoutV1 } from '../widgets/widgetPublicSnapshotV1.js';
export { PUBLIC_PROFILE_PAGE_COPY_EN, PUBLIC_PROFILE_FIELD_COPY_EN, PUBLIC_USAGE_CHART_COPY_EN,
  PUBLIC_USAGE_PLANET_COPY_EN, PUBLIC_USAGE_ORIGINAL_COPY_EN } from './publicProfilePresentationCopy.js';
const theme = z.enum(['auto', 'light', 'dark']);
const serviceUrl = z.string().check(z.url(), z.refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}));
export const PublicProfileAppearanceV1Schema = lazyZodSchema(() => z.strictObject({ atmosphere: PublicProfileAtmosphereV1Schema, theme }));
export const PublicProfilePreparedAppearanceV1Schema = lazyZodSchema(() => z.strictObject({ atmosphere: PublicProfilePreparedAtmosphereV1Schema, theme }));
export type PublicProfileAppearanceV1 = z.infer<typeof PublicProfileAppearanceV1Schema>;
export type PublicProfilePreparedAppearanceV1 = z.infer<typeof PublicProfilePreparedAppearanceV1Schema>;
export const DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1: PublicProfileAppearanceV1 = { atmosphere: { source: 'planet',
  planet: { intensity: 'quiet', digits: false } }, theme: 'auto' };
export const DEFAULT_PUBLIC_PROFILE_LAYOUT_V1 = { v: 1, items: [] } as const;
export const PublicProfileServiceV1Schema = lazyZodSchema(() => z.strictObject({ displayName: z.string(), publicBaseUrl: serviceUrl }));
export const PublicProfileUrlsV1Schema = lazyZodSchema(() => z.strictObject({ page: serviceUrl,
  json: serviceUrl, badgeBase: serviceUrl, card: serviceUrl,
  og: serviceUrl, report: z.string().check(z.refine(value => normalizePublicProfileReportUrlV1(value) !== null)),
}));
export const PublicProfileContextV1Schema = lazyZodSchema(() => z.strictObject({ handle: z.nullable(z.string()),
  identity: PublicProfileIdentityV1Schema, service: z.nullable(PublicProfileServiceV1Schema), urls: z.nullable(PublicProfileUrlsV1Schema),
}));
export type PublicProfileContextV1 = z.infer<typeof PublicProfileContextV1Schema>;
const id = z.string().check(z.minLength(1));
const frameStyle = z.enum(['card', 'plain']);
export const PublicProfileViewWidgetV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('widget'), id,
  size: WidgetGridSizeV1Schema, frameStyle, title: WidgetInstanceV1Schema.shape.displayName,
  presentation: z.union([z.strictObject({ kind: z.literal('declarative'), document: WidgetSnapshotDocumentV1Schema }), BuiltinUsagePublicPresentationV1Schema]),
}));
export const PublicProfileViewLayoutV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1),
  items: z.array(z.discriminatedUnion('kind', [PublicProfileViewWidgetV1Schema,
    z.strictObject({ kind: z.literal('group'), id, title: z.optional(z.string()), width: WidgetGroupWidthV1Schema, frameStyle,
      dividers: z.enum(['hairline', 'none']), children: z.array(PublicProfileViewWidgetV1Schema).check(z.minLength(1)) }),
  ])),
}));
export const PublicProfileViewV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1), handle: z.string(),
  indexable: z.boolean(),
  relativePeriod: z.optional(UsageRelativePeriodSchema),
  service: PublicProfileServiceV1Schema, state: z.literal('published'), identity: PublicProfileIdentityV1Schema,
  metadata: PublicProfileMetadataV1Schema, snapshot: PublicProfileSnapshotV1Schema, layout: PublicProfileViewLayoutV1Schema,
  appearance: PublicProfileAppearanceV1Schema, urls: PublicProfileUrlsV1Schema,
}));
export type PublicProfileViewV1 = z.infer<typeof PublicProfileViewV1Schema>;
/** Local preview can precede public destination setup; anonymous views still require URLs and applied references. */
export const PublicProfileLocalPreviewViewV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.omit(PublicProfileViewV1Schema, { appearance: true, service: true, urls: true }).shape,
  service: PublicProfileContextV1Schema.shape.service,
  urls: PublicProfileContextV1Schema.shape.urls,
  appearance: PublicProfilePreparedAppearanceV1Schema,
}));
export type PublicProfileLocalPreviewViewV1 = z.infer<typeof PublicProfileLocalPreviewViewV1Schema>;
export const PublicProfileReadResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('published'), view: PublicProfileViewV1Schema }),
  z.strictObject({ kind: z.literal('paused'), handle: z.string(), identity: z.omit(PublicProfileIdentityV1Schema, { supporter: true }) }),
  z.strictObject({ kind: z.literal('unavailable') }),
]));
export type PublicProfileReadResultV1 = z.infer<typeof PublicProfileReadResultV1Schema>;
const selections = z.array(ScmCredentialFreeRepositorySelectorV1Schema);
const count = z.number().check(z.int(), z.nonnegative());
export const PublicProfileOwnerRecordV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.enum(['draft', 'published', 'paused']), policy: z.nullable(PublicProfilePolicyV1Schema),
  metadata: z.nullable(PublicProfileMetadataV1Schema), projectSelections: selections,
  query: z.nullable(UsageQuerySchema), snapshot: z.nullable(PublicProfileSnapshotV1Schema),
  layout: z.nullable(PublicProfileLayoutV1Schema), appearance: z.nullable(PublicProfileAppearanceV1Schema),
  updatedAtMs: count, publishedAtMs: z.nullable(count),
  restriction: z.nullable(z.strictObject({ removedAtMs: count, reason: z.string() })),
}));
export type PublicProfileOwnerRecordV1 = z.infer<typeof PublicProfileOwnerRecordV1Schema>;
export const PublicProfileOwnerReadV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent'), context: PublicProfileContextV1Schema }),
  z.strictObject({ kind: z.literal('ready'), record: PublicProfileOwnerRecordV1Schema, context: PublicProfileContextV1Schema }),
]));
export type PublicProfileOwnerReadV1 = z.infer<typeof PublicProfileOwnerReadV1Schema>;
/** Prepared HTTP disclosure declares its population; ordinary Action intents remain broader. */
const preparedQuery = lazyZodSchema(() => z.strictObject({
  ...UsageQuerySchema.shape, population: z.literal('public_eligible_personal'),
}));
export const PublicProfilePublishBodyV1Schema = lazyZodSchema(() => z.strictObject({
  policy: PublicProfilePolicyV1Schema, metadata: PublicProfileMetadataV1Schema, projectSelections: selections,
  query: preparedQuery, snapshot: PublicProfileSnapshotV1Schema, layout: PublicProfileLayoutV1Schema,
  appearance: PublicProfilePreparedAppearanceV1Schema,
}));
export const PublicProfileUpdateBodyV1Schema = lazyZodSchema(() => z.strictObject({
  policy: z.optional(PublicProfilePolicyV1Schema), metadata: z.optional(PublicProfileMetadataV1Schema), projectSelections: z.optional(selections),
  query: z.optional(preparedQuery), snapshot: z.optional(PublicProfileSnapshotV1Schema),
  layout: z.optional(PublicProfileLayoutV1Schema), appearance: z.optional(PublicProfilePreparedAppearanceV1Schema),
}).check(z.refine(value => Object.values(value).some(value => value !== undefined))));
export const PublicProfileRefreshBodyV1Schema = lazyZodSchema(() => z.strictObject({
  query: preparedQuery, snapshot: PublicProfileSnapshotV1Schema, projectLinks: z.optional(z.array(PublicProfileLinkV1Schema)),
}));
export const PublicProfilePreparedRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('publish'), body: PublicProfilePublishBodyV1Schema }),
  z.strictObject({ operation: z.literal('resume'), body: PublicProfileRefreshBodyV1Schema }),
  z.strictObject({ operation: z.literal('update'), body: PublicProfileUpdateBodyV1Schema }),
  z.strictObject({ operation: z.literal('refresh'), body: PublicProfileRefreshBodyV1Schema }),
]));
export type PublicProfilePreparedRequestV1 = z.infer<typeof PublicProfilePreparedRequestV1Schema>;
export type PublicProfilePublishBodyV1 = z.infer<typeof PublicProfilePublishBodyV1Schema>;
export type PublicProfileUpdateBodyV1 = z.infer<typeof PublicProfileUpdateBodyV1Schema>;
export type PublicProfileRefreshBodyV1 = z.infer<typeof PublicProfileRefreshBodyV1Schema>;
export const PublicProfileUnavailableReasonV1Schema = z.enum(['feature_disabled', 'username_required', 'report_contact_unconfigured',
  'public_ingress_unconfigured', 'not_published', 'restricted', 'query_mismatch', 'invalid_stored_content', 'asset_unavailable']);
export const PublicProfileMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('updated'), record: z.nullable(PublicProfileOwnerRecordV1Schema) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: PublicProfileUnavailableReasonV1Schema }),
]));
export type PublicProfileMutationResultV1 = z.infer<typeof PublicProfileMutationResultV1Schema>;
export const PublicProfileReportRequestV1Schema = lazyZodSchema(() => z.strictObject({ handle: z.string() }));
export const PublicProfileReportResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), url: PublicProfileUrlsV1Schema.shape.report }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.literal('report_contact_unconfigured') }),
]));
export type PublicProfileReportResultV1 = z.infer<typeof PublicProfileReportResultV1Schema>;
