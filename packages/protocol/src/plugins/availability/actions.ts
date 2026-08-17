import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginCollectionContractRefV1Schema } from '../data/collectionsV1.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginUiArtifactCompatibilityKeyV1Schema } from '../ui/artifactCompatibility.js';
import { PluginUiArtifactDigestV1Schema } from '../ui/artifactIntegrity.js';
import {
  PluginAccountAvailabilityIntentReadResponseV1Schema,
  PluginAccountAvailabilityIntentIdsListResponseV1Schema,
  PluginAccountAvailabilityMaterializationsReadResponseV1Schema,
  PluginAccountAvailabilityReleaseReadResponseV1Schema,
  PluginAccountPluginIntentV1Schema,
  PluginAccountPluginPackageAssetLinkV1Schema,
  PluginAccountPluginUiArtifactLinkV1Schema,
  PluginMachineMaterializationSnapshotV1Schema,
  PluginReleaseFactsV1Schema,
  PluginReleaseRefV1Schema,
  PluginUiReleaseSlotV1Schema,
} from './v1.js';

const ArtifactIdSchema = z.string().uuid();
const Base64BytesSchema = z.string().min(1);
const IntentRevisionSchema = z.string().trim().min(1).max(128);

/**
 * These are Account control-plane operation names, not plugin-contributed
 * Actions. They identify the one Availability API family without creating a
 * second generic Artifact transport or a release-allocation protocol.
 */
export const PLUGIN_AVAILABILITY_ACTION_IDS_V1 = Object.freeze([
  'account.plugins.availability.intent.read',
  'account.plugins.availability.intents.list',
  'account.plugins.availability.intent.set',
  'account.plugins.availability.release.read',
  'account.plugins.availability.release.publish',
  'account.plugins.availability.materializations.report',
  'account.plugins.availability.materializations.read',
  'account.plugins.availability.uiArtifact.publish',
  'account.plugins.availability.uiArtifact.read',
  'account.plugins.availability.uiArtifact.remove',
  'account.plugins.availability.uiArtifact.browserFrame.issue',
  'account.plugins.availability.packageAsset.publish',
  'account.plugins.availability.packageAsset.read',
] as const);
export const PluginAvailabilityActionIdV1Schema = z.enum(PLUGIN_AVAILABILITY_ACTION_IDS_V1);
export type PluginAvailabilityActionIdV1 = z.infer<typeof PluginAvailabilityActionIdV1Schema>;

/**
 * The one HTTP projection for the bounded Availability operation family.
 * Server and CLI adapt these paths to their incumbent authenticated transports;
 * individual consumers do not allocate parallel Availability endpoints.
 */
export const PluginAvailabilityActionHttpPathsV1 = Object.freeze({
  'account.plugins.availability.intent.read': '/v1/plugins/availability/intents/read',
  'account.plugins.availability.intents.list': '/v1/plugins/availability/intents/list',
  'account.plugins.availability.intent.set': '/v1/plugins/availability/intents/set',
  'account.plugins.availability.release.read': '/v1/plugins/availability/releases/read',
  'account.plugins.availability.release.publish': '/v1/plugins/availability/releases/publish',
  'account.plugins.availability.materializations.report': '/v1/plugins/availability/materializations/report',
  'account.plugins.availability.materializations.read': '/v1/plugins/availability/materializations/read',
  'account.plugins.availability.uiArtifact.publish': '/v1/plugins/availability/ui-artifacts/publish',
  'account.plugins.availability.uiArtifact.read': '/v1/plugins/availability/ui-artifacts/read',
  'account.plugins.availability.uiArtifact.remove': '/v1/plugins/availability/ui-artifacts/remove',
  'account.plugins.availability.uiArtifact.browserFrame.issue': '/v1/plugins/availability/ui-artifacts/browser-frame/issue',
  'account.plugins.availability.packageAsset.publish': '/v1/plugins/availability/package-assets/publish',
  'account.plugins.availability.packageAsset.read': '/v1/plugins/availability/package-assets/read',
} as const satisfies Readonly<Record<PluginAvailabilityActionIdV1, string>>);
export type PluginAvailabilityActionHttpPathV1 =
  (typeof PluginAvailabilityActionHttpPathsV1)[PluginAvailabilityActionIdV1];

export const PluginAvailabilityIntentReadActionInputV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
}).strict();
export type PluginAvailabilityIntentReadActionInputV1 = z.infer<typeof PluginAvailabilityIntentReadActionInputV1Schema>;

export const PluginAvailabilityIntentReadActionOutputV1Schema =
  PluginAccountAvailabilityIntentReadResponseV1Schema;
export type PluginAvailabilityIntentReadActionOutputV1 = z.infer<typeof PluginAvailabilityIntentReadActionOutputV1Schema>;

/**
 * Lists only selected intent ids for Availability bootstrap. Exact intent
 * details stay on the incumbent per-plugin read operation.
 */
export const PluginAvailabilityIntentsListActionInputV1Schema = z.object({
}).strict();
export type PluginAvailabilityIntentsListActionInputV1 = z.infer<typeof PluginAvailabilityIntentsListActionInputV1Schema>;

export const PluginAvailabilityIntentsListActionOutputV1Schema =
  PluginAccountAvailabilityIntentIdsListResponseV1Schema;
export type PluginAvailabilityIntentsListActionOutputV1 = z.infer<typeof PluginAvailabilityIntentsListActionOutputV1Schema>;

/**
 * Availability performs this CAS only after the Data owner reports every
 * supplied writable contract current and writable. The Data readiness proof
 * deliberately is not copied into this wire shape or persisted here.
 */
export const PluginAvailabilityIntentSetActionInputV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  desiredVersion: PluginReleaseRefV1Schema.shape.version.nullable(),
  enabled: z.boolean(),
  offlineUiHosting: z.enum(['disabled', 'enabled']),
  writableCollections: z.array(PluginCollectionContractRefV1Schema),
  expectedRevision: IntentRevisionSchema.nullable(),
}).strict();
export type PluginAvailabilityIntentSetActionInputV1 = z.infer<typeof PluginAvailabilityIntentSetActionInputV1Schema>;

export const PluginAvailabilityIntentSetActionOutputV1Schema = z.object({
  intent: PluginAccountPluginIntentV1Schema,
}).strict();
export type PluginAvailabilityIntentSetActionOutputV1 = z.infer<typeof PluginAvailabilityIntentSetActionOutputV1Schema>;

/** The only source kinds eligible to bind a portable Account release. */
export const PluginAvailabilityPortableReleaseSourceClassV1Schema = z.enum([
  'bundledFirstParty',
  'registryPackage',
  'versionedArchive',
]);
export type PluginAvailabilityPortableReleaseSourceClassV1 =
  z.infer<typeof PluginAvailabilityPortableReleaseSourceClassV1Schema>;

export const PluginAvailabilityReleasePublishActionInputV1Schema = z.object({
  facts: PluginReleaseFactsV1Schema,
  /**
   * Existing acquisition supplies this only after it has verified the exact
   * archive. It is admission evidence, never a stored release identity.
   */
  sourceClass: PluginAvailabilityPortableReleaseSourceClassV1Schema,
}).strict();
export type PluginAvailabilityReleasePublishActionInputV1 = z.infer<typeof PluginAvailabilityReleasePublishActionInputV1Schema>;

export const PluginAvailabilityReleasePublishActionOutputV1Schema = z.object({
  facts: PluginReleaseFactsV1Schema,
  outcome: z.enum(['created', 'rejoined']),
}).strict();
export type PluginAvailabilityReleasePublishActionOutputV1 = z.infer<typeof PluginAvailabilityReleasePublishActionOutputV1Schema>;

/**
 * This target read names one immutable release coordinate only. It does not
 * consult or expose Account selection intent, acquisition state, or catalog
 * ranking.
 */
export const PluginAvailabilityReleaseReadActionInputV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
}).strict();
export type PluginAvailabilityReleaseReadActionInputV1 =
  z.infer<typeof PluginAvailabilityReleaseReadActionInputV1Schema>;

export const PluginAvailabilityReleaseReadActionOutputV1Schema =
  PluginAccountAvailabilityReleaseReadResponseV1Schema;
export type PluginAvailabilityReleaseReadActionOutputV1 =
  z.infer<typeof PluginAvailabilityReleaseReadActionOutputV1Schema>;

export const PluginAvailabilityMaterializationsReportActionInputV1Schema = z.object({
  snapshot: PluginMachineMaterializationSnapshotV1Schema,
}).strict();
export type PluginAvailabilityMaterializationsReportActionInputV1 = z.infer<typeof PluginAvailabilityMaterializationsReportActionInputV1Schema>;

export const PluginAvailabilityMaterializationsReportActionOutputV1Schema = z.object({
  snapshot: PluginMachineMaterializationSnapshotV1Schema,
  outcome: z.enum(['replaced', 'rejoined']),
}).strict();
export type PluginAvailabilityMaterializationsReportActionOutputV1 = z.infer<typeof PluginAvailabilityMaterializationsReportActionOutputV1Schema>;

export const PluginAvailabilityMaterializationsReadActionInputV1Schema = z.object({
}).strict();
export type PluginAvailabilityMaterializationsReadActionInputV1 = z.infer<typeof PluginAvailabilityMaterializationsReadActionInputV1Schema>;

export const PluginAvailabilityMaterializationsReadActionOutputV1Schema =
  PluginAccountAvailabilityMaterializationsReadResponseV1Schema;
export type PluginAvailabilityMaterializationsReadActionOutputV1 = z.infer<typeof PluginAvailabilityMaterializationsReadActionOutputV1Schema>;

/**
 * The three byte fields are the existing generic Artifact create envelope.
 * Availability composes it with one classification-link transaction; it does
 * not define an archive/blob/upload protocol.
 */
export const PluginAvailabilityArtifactCreateEnvelopeV1Schema = z.object({
  header: Base64BytesSchema,
  body: Base64BytesSchema,
  dataEncryptionKey: Base64BytesSchema,
}).strict();
export type PluginAvailabilityArtifactCreateEnvelopeV1 = z.infer<typeof PluginAvailabilityArtifactCreateEnvelopeV1Schema>;

export const PluginAvailabilityUiArtifactPublishActionInputV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
  slot: PluginUiReleaseSlotV1Schema,
  /**
   * Current host/adoption facts belong to the classified Artifact link, not
   * the portable release slot. The server verifies their portable projection
   * before it persists the link.
   */
  hostCompatibility: PluginUiArtifactCompatibilityKeyV1Schema,
  artifactId: ArtifactIdSchema,
  artifact: PluginAvailabilityArtifactCreateEnvelopeV1Schema,
}).strict();
export type PluginAvailabilityUiArtifactPublishActionInputV1 = z.infer<typeof PluginAvailabilityUiArtifactPublishActionInputV1Schema>;

export const PluginAvailabilityUiArtifactPublishActionOutputV1Schema = z.object({
  link: PluginAccountPluginUiArtifactLinkV1Schema,
  outcome: z.enum(['created', 'rejoined']),
}).strict();
export type PluginAvailabilityUiArtifactPublishActionOutputV1 = z.infer<typeof PluginAvailabilityUiArtifactPublishActionOutputV1Schema>;

const PluginAvailabilityUiArtifactTargetV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
  contributionId: PluginUiReleaseSlotV1Schema.shape.contributionId,
  tier: PluginUiReleaseSlotV1Schema.shape.tier,
  platform: PluginUiReleaseSlotV1Schema.shape.platform,
}).strict();

/**
 * Absence preserves the incumbent current-render policy. The sole explicit
 * purpose admits an authenticated present-user host to prepare the named
 * immutable candidate without granting generic or current-render authority.
 */
export const PluginAvailabilityUiArtifactReadPurposeV1Schema =
  z.literal('candidatePreparation');
export type PluginAvailabilityUiArtifactReadPurposeV1 =
  z.infer<typeof PluginAvailabilityUiArtifactReadPurposeV1Schema>;

const PluginAvailabilityUiArtifactCandidatePreparationReadActionInputV1Schema =
  PluginAvailabilityUiArtifactTargetV1Schema.extend({
    purpose: PluginAvailabilityUiArtifactReadPurposeV1Schema,
    expectedArtifactDigest: PluginUiArtifactDigestV1Schema,
  }).strict();

export const PluginAvailabilityUiArtifactReadActionInputV1Schema =
  z.union([
    PluginAvailabilityUiArtifactTargetV1Schema,
    PluginAvailabilityUiArtifactCandidatePreparationReadActionInputV1Schema,
  ]);
export type PluginAvailabilityUiArtifactReadActionInputV1 = z.infer<typeof PluginAvailabilityUiArtifactReadActionInputV1Schema>;

/** Logical Artifact bytes are opened by the incumbent Artifact envelope owner. */
export const PluginAvailabilityArtifactReadEnvelopeV1Schema = z.object({
  header: Base64BytesSchema,
  headerVersion: z.number().int().positive(),
  body: Base64BytesSchema,
  bodyVersion: z.number().int().positive(),
  dataEncryptionKey: Base64BytesSchema,
  seq: z.number().int().nonnegative(),
}).strict();
export type PluginAvailabilityArtifactReadEnvelopeV1 = z.infer<typeof PluginAvailabilityArtifactReadEnvelopeV1Schema>;

export const PluginAvailabilityUiArtifactReadActionOutputV1Schema = z.object({
  link: PluginAccountPluginUiArtifactLinkV1Schema,
  artifact: PluginAvailabilityArtifactReadEnvelopeV1Schema,
}).strict();
export type PluginAvailabilityUiArtifactReadActionOutputV1 = z.infer<typeof PluginAvailabilityUiArtifactReadActionOutputV1Schema>;

/**
 * Package assets use the incumbent Artifact envelope for their protected
 * bytes. Callers name only a release coordinate: no path, archive content,
 * URL, or local filesystem authority crosses the Availability boundary.
 */
export const PluginAvailabilityPackageAssetPublishActionInputV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
  artifactId: ArtifactIdSchema,
  artifact: PluginAvailabilityArtifactCreateEnvelopeV1Schema,
}).strict();
export type PluginAvailabilityPackageAssetPublishActionInputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetPublishActionInputV1Schema>;

export const PluginAvailabilityPackageAssetPublishActionOutputV1Schema = z.object({
  link: PluginAccountPluginPackageAssetLinkV1Schema,
  outcome: z.enum(['created', 'rejoined']),
}).strict();
export type PluginAvailabilityPackageAssetPublishActionOutputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetPublishActionOutputV1Schema>;

export const PluginAvailabilityPackageAssetReadActionInputV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
}).strict();
export type PluginAvailabilityPackageAssetReadActionInputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetReadActionInputV1Schema>;

export const PluginAvailabilityPackageAssetReadActionOutputV1Schema = z.object({
  link: PluginAccountPluginPackageAssetLinkV1Schema,
  artifact: PluginAvailabilityArtifactReadEnvelopeV1Schema,
}).strict();
export type PluginAvailabilityPackageAssetReadActionOutputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetReadActionOutputV1Schema>;

/**
 * The authenticated control-plane request names only the already-selected
 * Artifact. Availability derives its fixed generated-V2 path/CSP policy from
 * the opened archive and its embedding origin from deployment configuration;
 * callers cannot widen either authority, nor provide URLs, credentials, bytes,
 * cache handles, or bridge authority.
 */
export const PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema = z.object({
  release: PluginReleaseRefV1Schema,
  contributionId: PluginUiReleaseSlotV1Schema.shape.contributionId,
  tier: z.literal('hostedWeb'),
  platform: z.literal('web'),
  expectedArtifactDigest: PluginUiArtifactDigestV1Schema,
}).strict();
export type PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1 = z.infer<typeof PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema>;

function isHttpsCapabilityUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username.length === 0
      && url.password.length === 0
      && url.search.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}

export const PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema = z.object({
  url: z.string().trim().min(1).max(16 * 1024).refine(
    isHttpsCapabilityUrl,
    'Expected an HTTPS Artifact capability URL without credentials, query, or fragment',
  ),
  expiresAt: z.number().int().positive(),
}).strict();
export type PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1 = z.infer<typeof PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema>;

export const PluginAvailabilityUiArtifactRemoveActionInputV1Schema =
  PluginAvailabilityUiArtifactTargetV1Schema;
export type PluginAvailabilityUiArtifactRemoveActionInputV1 = z.infer<typeof PluginAvailabilityUiArtifactRemoveActionInputV1Schema>;

export const PluginAvailabilityUiArtifactRemoveActionOutputV1Schema = z.object({
  removed: z.literal(true),
  link: PluginAccountPluginUiArtifactLinkV1Schema,
}).strict();
export type PluginAvailabilityUiArtifactRemoveActionOutputV1 = z.infer<typeof PluginAvailabilityUiArtifactRemoveActionOutputV1Schema>;

export const PluginAvailabilityActionInputSchemasV1: Readonly<
  Record<PluginAvailabilityActionIdV1, z.ZodTypeAny>
> = Object.freeze({
  'account.plugins.availability.intent.read': PluginAvailabilityIntentReadActionInputV1Schema,
  'account.plugins.availability.intents.list': PluginAvailabilityIntentsListActionInputV1Schema,
  'account.plugins.availability.intent.set': PluginAvailabilityIntentSetActionInputV1Schema,
  'account.plugins.availability.release.read': PluginAvailabilityReleaseReadActionInputV1Schema,
  'account.plugins.availability.release.publish': PluginAvailabilityReleasePublishActionInputV1Schema,
  'account.plugins.availability.materializations.report': PluginAvailabilityMaterializationsReportActionInputV1Schema,
  'account.plugins.availability.materializations.read': PluginAvailabilityMaterializationsReadActionInputV1Schema,
  'account.plugins.availability.uiArtifact.publish': PluginAvailabilityUiArtifactPublishActionInputV1Schema,
  'account.plugins.availability.uiArtifact.read': PluginAvailabilityUiArtifactReadActionInputV1Schema,
  'account.plugins.availability.uiArtifact.remove': PluginAvailabilityUiArtifactRemoveActionInputV1Schema,
  'account.plugins.availability.uiArtifact.browserFrame.issue': PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema,
  'account.plugins.availability.packageAsset.publish': PluginAvailabilityPackageAssetPublishActionInputV1Schema,
  'account.plugins.availability.packageAsset.read': PluginAvailabilityPackageAssetReadActionInputV1Schema,
});

export const PluginAvailabilityActionOutputSchemasV1: Readonly<
  Record<PluginAvailabilityActionIdV1, z.ZodTypeAny>
> = Object.freeze({
  'account.plugins.availability.intent.read': PluginAvailabilityIntentReadActionOutputV1Schema,
  'account.plugins.availability.intents.list': PluginAvailabilityIntentsListActionOutputV1Schema,
  'account.plugins.availability.intent.set': PluginAvailabilityIntentSetActionOutputV1Schema,
  'account.plugins.availability.release.read': PluginAvailabilityReleaseReadActionOutputV1Schema,
  'account.plugins.availability.release.publish': PluginAvailabilityReleasePublishActionOutputV1Schema,
  'account.plugins.availability.materializations.report': PluginAvailabilityMaterializationsReportActionOutputV1Schema,
  'account.plugins.availability.materializations.read': PluginAvailabilityMaterializationsReadActionOutputV1Schema,
  'account.plugins.availability.uiArtifact.publish': PluginAvailabilityUiArtifactPublishActionOutputV1Schema,
  'account.plugins.availability.uiArtifact.read': PluginAvailabilityUiArtifactReadActionOutputV1Schema,
  'account.plugins.availability.uiArtifact.remove': PluginAvailabilityUiArtifactRemoveActionOutputV1Schema,
  'account.plugins.availability.uiArtifact.browserFrame.issue': PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema,
  'account.plugins.availability.packageAsset.publish': PluginAvailabilityPackageAssetPublishActionOutputV1Schema,
  'account.plugins.availability.packageAsset.read': PluginAvailabilityPackageAssetReadActionOutputV1Schema,
});
