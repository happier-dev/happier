import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import * as mini from '../../zodRuntimePolicy.js';
import { ManagedResourceDispositionV1Schema } from '../../machines/managed/managedDependencyV1.js';
import { ManagedControllerV1Schema } from '../../machines/managed/managedMachineV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginCollectionContractRefV1Schema } from '../data/collectionContractRefV1.js';
import { PluginAccountCollectionContributionV1Schema } from '../data/collectionContributionV1.js';
import { PluginCollectionCandidatePreparationBindingV1Schema } from '../data/collectionsV1.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginUiArtifactDigestV1Schema } from '../ui/artifactIntegrity.js';
import {
  PluginAccountAvailabilityIntentReadResponseV1Schema,
  PluginAccountAvailabilityIntentsListResponseV1Schema,
  PluginAccountAvailabilityMaterializationsReadResponseV1Schema,
  PluginAccountAvailabilityReleaseReadResponseV1Schema,
  PluginAccountPluginIntentV1Schema,
  PluginAccountPluginPackageAssetLinkV1Schema,
  PluginAccountPluginUiArtifactLinkV1Schema,
  PluginMachineMaterializationSnapshotV1Schema,
  PluginPortableReleaseManifestV1Schema,
  PluginReleaseFactsV1Schema,
  PluginReleaseRefV1Schema,
  PluginUiReleaseSlotV1Schema,
  type PluginAccountAvailabilityReleaseReadResponseV1,
} from './v1.js';

const ArtifactIdSchema = lazyZodSchema(() => z.string().check(z.uuid()));
const Base64BytesSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const IntentRevisionSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(128)));

/**
 * These are Account control-plane operation names, not plugin-contributed
 * Actions. They identify the one Availability API family without creating a
 * second generic Artifact transport or a release-allocation protocol.
 */
export const PLUGIN_AVAILABILITY_ACTION_IDS_V1 = Object.freeze([
  'account.plugins.availability.intent.read',
  'account.plugins.availability.intents.list',
  'account.plugins.availability.intent.set',
  'account.plugins.availability.collectionWriters.claim',
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
  'account.plugins.availability.packageAsset.remove',
] as const);
export const PluginAvailabilityActionIdV1Schema = lazyZodSchema(() => z.enum(PLUGIN_AVAILABILITY_ACTION_IDS_V1));
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
  'account.plugins.availability.collectionWriters.claim': '/v1/plugins/availability/collection-writers/claim',
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
  'account.plugins.availability.packageAsset.remove': '/v1/plugins/availability/package-assets/remove',
} as const satisfies Readonly<Record<PluginAvailabilityActionIdV1, string>>);
export type PluginAvailabilityActionHttpPathV1 =
  (typeof PluginAvailabilityActionHttpPathsV1)[PluginAvailabilityActionIdV1];

export const PluginAvailabilityIntentReadActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  includeManagedResources: z.optional(z.literal(true)),
  controller: mini.optional(ManagedControllerV1Schema),
  homeId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
}).check(z.superRefine((input, context) => {
  if ((input.managedResourceDispositions !== undefined || input.controller !== undefined || input.homeId !== undefined) && input.includeManagedResources !== true) {
    context.addIssue({ code: 'custom', path: ['managedResourceDispositions'], message: 'Resource review requires the current dependency census.' });
  }
  if (input.homeId !== undefined && input.controller === undefined) {
    context.addIssue({ code: 'custom', path: ['homeId'], message: 'Local resource review requires its controller installation.' });
  }
})));
export type PluginAvailabilityIntentReadActionInputV1 = z.infer<typeof PluginAvailabilityIntentReadActionInputV1Schema>;

export const PluginAvailabilityIntentReadActionOutputV1Schema: typeof PluginAccountAvailabilityIntentReadResponseV1Schema =
  PluginAccountAvailabilityIntentReadResponseV1Schema;
export type PluginAvailabilityIntentReadActionOutputV1 = z.infer<typeof PluginAvailabilityIntentReadActionOutputV1Schema>;

/**
 * Reads Account intents and caller-known identities through their canonical
 * read projection. Known ids include materialized plugins and previously read
 * intents so an absent intent still has an explicit current read.
 */
export const PluginAvailabilityIntentsListActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  knownPluginIds: z.optional(z.readonly(z.array(asProtocolZod(PluginIdSchema)))),
  cursor: mini.optional(asProtocolZod(PluginIdSchema)),
  /** The caller reads intent and release facts only: no declaration body or digest is projected or sent. */
  omitDeclarations: z.optional(z.literal(true)),
}));
export type PluginAvailabilityIntentsListActionInputV1 = z.infer<typeof PluginAvailabilityIntentsListActionInputV1Schema>;

export const PluginAvailabilityIntentsListActionOutputV1Schema =
  PluginAccountAvailabilityIntentsListResponseV1Schema;
export type PluginAvailabilityIntentsListActionOutputV1 = z.infer<typeof PluginAvailabilityIntentsListActionOutputV1Schema>;

/**
 * Availability performs this CAS only after the Data owner reports every
 * supplied writable contract current and writable. The Data readiness proof
 * deliberately is not copied into this wire shape or persisted here.
 */
export const PluginAvailabilityIntentSetActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  desiredVersion: z.nullable(PluginReleaseRefV1Schema.shape.version),
  enabled: z.boolean(),
  offlineUiHosting: z.enum(['disabled', 'enabled']),
  writableCollections: z.array(PluginCollectionContractRefV1Schema),
  expectedRevision: z.nullable(IntentRevisionSchema),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
}));
export type PluginAvailabilityIntentSetActionInputV1 = z.infer<typeof PluginAvailabilityIntentSetActionInputV1Schema>;

export const PluginAvailabilityIntentSetActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  intent: PluginAccountPluginIntentV1Schema,
}));
export type PluginAvailabilityIntentSetActionOutputV1 = z.infer<typeof PluginAvailabilityIntentSetActionOutputV1Schema>;

/**
 * A daemon-selected plugin (bundled first-party, trusted development, or
 * drop-in) has no portable Account release. Its host claims the Account's
 * release-less intent with the plugin's own admitted normalized manifest: the
 * server stores it as the release-less declaration that webhook and Event
 * currentness read, and rebuilds every Collection contract and digest from its
 * `contributes.accountCollections`. The claim lands on the same intent row as
 * `intent.set`, never overrides a present-user release selection, and never
 * lowers a collection's schemaVersion or the declaration version.
 */
export const PluginAvailabilityCollectionWritersClaimActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  manifest: PluginPortableReleaseManifestV1Schema,
  /** Read exact incumbent declarations/bindings without moving the writer. */
  prepare: z.optional(z.literal(true)),
}));
export type PluginAvailabilityCollectionWritersClaimActionInputV1 =
  z.infer<typeof PluginAvailabilityCollectionWritersClaimActionInputV1Schema>;

export const PluginAvailabilityCollectionWritersClaimActionOutputV1Schema =
  lazyZodSchema(() => z.extend(PluginAvailabilityIntentSetActionOutputV1Schema, {
    preparation: z.optional(z.array(z.strictObject({
      source: PluginAccountCollectionContributionV1Schema,
      binding: PluginCollectionCandidatePreparationBindingV1Schema,
    }))),
  }));
export type PluginAvailabilityCollectionWritersClaimActionOutputV1 =
  z.infer<typeof PluginAvailabilityCollectionWritersClaimActionOutputV1Schema>;

/** The only source kinds eligible to bind a portable Account release. */
export const PluginAvailabilityPortableReleaseSourceClassV1Schema = lazyZodSchema(() => z.enum([
  'registryPackage',
  'versionedArchive',
]));
export type PluginAvailabilityPortableReleaseSourceClassV1 =
  z.infer<typeof PluginAvailabilityPortableReleaseSourceClassV1Schema>;

export const PluginAvailabilityReleasePublishActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  facts: PluginReleaseFactsV1Schema,
  /**
   * Existing acquisition supplies this only after it has verified the exact
   * archive. It is admission evidence, never a stored release identity.
   */
  sourceClass: PluginAvailabilityPortableReleaseSourceClassV1Schema,
}));
export type PluginAvailabilityReleasePublishActionInputV1 = z.infer<typeof PluginAvailabilityReleasePublishActionInputV1Schema>;

export const PluginAvailabilityReleasePublishActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  facts: PluginReleaseFactsV1Schema,
  outcome: z.enum(['created', 'rejoined']),
}));
export type PluginAvailabilityReleasePublishActionOutputV1 = z.infer<typeof PluginAvailabilityReleasePublishActionOutputV1Schema>;

/**
 * This target read names one immutable release coordinate only. It does not
 * consult or expose Account selection intent, acquisition state, or catalog
 * ranking.
 */
export const PluginAvailabilityReleaseReadActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
}));
export type PluginAvailabilityReleaseReadActionInputV1 =
  z.infer<typeof PluginAvailabilityReleaseReadActionInputV1Schema>;

export type PluginAvailabilityReleaseReadActionOutputV1 = PluginAccountAvailabilityReleaseReadResponseV1;
export const PluginAvailabilityReleaseReadActionOutputV1Schema: z.ZodMiniType<PluginAvailabilityReleaseReadActionOutputV1> =
  PluginAccountAvailabilityReleaseReadResponseV1Schema;

export const PluginAvailabilityMaterializationsReportActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
  snapshot: PluginMachineMaterializationSnapshotV1Schema,
}));
export type PluginAvailabilityMaterializationsReportActionInputV1 = z.infer<typeof PluginAvailabilityMaterializationsReportActionInputV1Schema>;

export const PluginAvailabilityMaterializationsReportActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  revision: z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
  outcome: z.enum(['replaced', 'rejoined', 'conflict']),
}));
export type PluginAvailabilityMaterializationsReportActionOutputV1 = z.infer<typeof PluginAvailabilityMaterializationsReportActionOutputV1Schema>;

export const PluginAvailabilityMaterializationsReadActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  /** A reader that needs only these plugins (e.g. a Session's selected plugin skills) names them; omitted reads every materialization. */
  pluginIds: z.optional(z.readonly(z.array(asProtocolZod(PluginIdSchema)))),
}));
export type PluginAvailabilityMaterializationsReadActionInputV1 = z.infer<typeof PluginAvailabilityMaterializationsReadActionInputV1Schema>;

export const PluginAvailabilityMaterializationsReadActionOutputV1Schema =
  PluginAccountAvailabilityMaterializationsReadResponseV1Schema;
export type PluginAvailabilityMaterializationsReadActionOutputV1 = z.infer<typeof PluginAvailabilityMaterializationsReadActionOutputV1Schema>;

/**
 * The three byte fields are the existing generic Artifact create envelope.
 * Availability composes it with one classification-link transaction; it does
 * not define an archive/blob/upload protocol.
 */
export const PluginAvailabilityArtifactCreateEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  header: Base64BytesSchema,
  body: Base64BytesSchema,
  dataEncryptionKey: Base64BytesSchema,
}));
export type PluginAvailabilityArtifactCreateEnvelopeV1 = z.infer<typeof PluginAvailabilityArtifactCreateEnvelopeV1Schema>;

export const PluginAvailabilityUiArtifactPublishActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
  slot: PluginUiReleaseSlotV1Schema,
  accountArtifactId: ArtifactIdSchema,
  artifact: PluginAvailabilityArtifactCreateEnvelopeV1Schema,
}));
export type PluginAvailabilityUiArtifactPublishActionInputV1 = z.infer<typeof PluginAvailabilityUiArtifactPublishActionInputV1Schema>;

export const PluginAvailabilityUiArtifactPublishActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  link: PluginAccountPluginUiArtifactLinkV1Schema,
  outcome: z.enum(['created', 'rejoined']),
}));
export type PluginAvailabilityUiArtifactPublishActionOutputV1 = z.infer<typeof PluginAvailabilityUiArtifactPublishActionOutputV1Schema>;

const PluginAvailabilityUiArtifactTargetV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
  contributionId: PluginUiReleaseSlotV1Schema.shape.contributionId,
  artifactId: PluginUiReleaseSlotV1Schema.shape.artifactId,
  tier: PluginUiReleaseSlotV1Schema.shape.tier,
  platform: PluginUiReleaseSlotV1Schema.shape.platform,
}));

/**
 * Absence preserves the incumbent current-render policy. The sole explicit
 * purpose admits an authenticated present-user host to prepare the named
 * immutable candidate without granting generic or current-render authority.
 */
export const PluginAvailabilityUiArtifactReadPurposeV1Schema =
  lazyZodSchema(() => z.literal('candidatePreparation'));
export type PluginAvailabilityUiArtifactReadPurposeV1 =
  z.infer<typeof PluginAvailabilityUiArtifactReadPurposeV1Schema>;

const PluginAvailabilityUiArtifactCandidatePreparationReadActionInputV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginAvailabilityUiArtifactTargetV1Schema, {
    purpose: PluginAvailabilityUiArtifactReadPurposeV1Schema,
    expectedArtifactDigest: PluginUiArtifactDigestV1Schema,
  })));

export const PluginAvailabilityUiArtifactReadActionInputV1Schema =
  lazyZodSchema(() => z.union([
    PluginAvailabilityUiArtifactTargetV1Schema,
    PluginAvailabilityUiArtifactCandidatePreparationReadActionInputV1Schema,
  ]));
export type PluginAvailabilityUiArtifactReadActionInputV1 = z.infer<typeof PluginAvailabilityUiArtifactReadActionInputV1Schema>;

/** Logical Artifact bytes are opened by the incumbent Artifact envelope owner. */
export const PluginAvailabilityArtifactReadEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  header: Base64BytesSchema,
  headerVersion: z.number().check(z.int(), z.positive()),
  body: Base64BytesSchema,
  bodyVersion: z.number().check(z.int(), z.positive()),
  dataEncryptionKey: Base64BytesSchema,
  seq: z.number().check(z.int(), z.nonnegative()),
}));
export type PluginAvailabilityArtifactReadEnvelopeV1 = z.infer<typeof PluginAvailabilityArtifactReadEnvelopeV1Schema>;

export const PluginAvailabilityUiArtifactReadActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  link: PluginAccountPluginUiArtifactLinkV1Schema,
  artifact: PluginAvailabilityArtifactReadEnvelopeV1Schema,
}));
export type PluginAvailabilityUiArtifactReadActionOutputV1 = z.infer<typeof PluginAvailabilityUiArtifactReadActionOutputV1Schema>;

/**
 * Package assets use the incumbent Artifact envelope for their protected
 * bytes. Callers name only a release coordinate: no path, archive content,
 * URL, or local filesystem authority crosses the Availability boundary.
 */
export const PluginAvailabilityPackageAssetPublishActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
  artifactId: ArtifactIdSchema,
  artifact: PluginAvailabilityArtifactCreateEnvelopeV1Schema,
}));
export type PluginAvailabilityPackageAssetPublishActionInputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetPublishActionInputV1Schema>;

export const PluginAvailabilityPackageAssetPublishActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  link: PluginAccountPluginPackageAssetLinkV1Schema,
  outcome: z.enum(['created', 'rejoined']),
}));
export type PluginAvailabilityPackageAssetPublishActionOutputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetPublishActionOutputV1Schema>;

export const PluginAvailabilityPackageAssetReadActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
}));
export type PluginAvailabilityPackageAssetReadActionInputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetReadActionInputV1Schema>;

export const PluginAvailabilityPackageAssetReadActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  link: PluginAccountPluginPackageAssetLinkV1Schema,
  artifact: PluginAvailabilityArtifactReadEnvelopeV1Schema,
}));
export type PluginAvailabilityPackageAssetReadActionOutputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetReadActionOutputV1Schema>;

export const PluginAvailabilityPackageAssetRemoveActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
}));
export type PluginAvailabilityPackageAssetRemoveActionInputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetRemoveActionInputV1Schema>;

export const PluginAvailabilityPackageAssetRemoveActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  removed: z.literal(true),
  link: PluginAccountPluginPackageAssetLinkV1Schema,
}));
export type PluginAvailabilityPackageAssetRemoveActionOutputV1 =
  z.infer<typeof PluginAvailabilityPackageAssetRemoveActionOutputV1Schema>;

/**
 * The authenticated control-plane request names only the already-selected
 * Artifact. Availability derives its fixed generated-V2 path/CSP policy from
 * the opened archive and its embedding origin from deployment configuration;
 * callers cannot widen either authority, nor provide URLs, credentials, bytes,
 * cache handles, or bridge authority.
 */
export const PluginAvailabilityUiArtifactBrowserFrameIssueActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
  contributionId: PluginUiReleaseSlotV1Schema.shape.contributionId,
  artifactId: PluginUiReleaseSlotV1Schema.shape.artifactId,
  tier: z.literal('hostedWeb'),
  platform: z.literal('web'),
  expectedArtifactDigest: PluginUiArtifactDigestV1Schema,
}));
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

export const PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  url: z.string().check(z.trim(), z.minLength(1), z.maxLength(16 * 1024), z.refine(isHttpsCapabilityUrl, 'Expected an HTTPS Artifact capability URL without credentials, query, or fragment')),
  expiresAt: z.number().check(z.int(), z.positive()),
}));
export type PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1 = z.infer<typeof PluginAvailabilityUiArtifactBrowserFrameIssueActionOutputV1Schema>;

export const PluginAvailabilityUiArtifactRemoveActionInputV1Schema =
  PluginAvailabilityUiArtifactTargetV1Schema;
export type PluginAvailabilityUiArtifactRemoveActionInputV1 = z.infer<typeof PluginAvailabilityUiArtifactRemoveActionInputV1Schema>;

export const PluginAvailabilityUiArtifactRemoveActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  removed: z.literal(true),
  link: PluginAccountPluginUiArtifactLinkV1Schema,
}));
export type PluginAvailabilityUiArtifactRemoveActionOutputV1 = z.infer<typeof PluginAvailabilityUiArtifactRemoveActionOutputV1Schema>;

export const PluginAvailabilityActionInputSchemasV1: Readonly<
  Record<PluginAvailabilityActionIdV1, z.ZodMiniType>
> = Object.freeze({
  'account.plugins.availability.intent.read': PluginAvailabilityIntentReadActionInputV1Schema,
  'account.plugins.availability.intents.list': PluginAvailabilityIntentsListActionInputV1Schema,
  'account.plugins.availability.intent.set': PluginAvailabilityIntentSetActionInputV1Schema,
  'account.plugins.availability.collectionWriters.claim': PluginAvailabilityCollectionWritersClaimActionInputV1Schema,
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
  'account.plugins.availability.packageAsset.remove': PluginAvailabilityPackageAssetRemoveActionInputV1Schema,
});

export const PluginAvailabilityActionOutputSchemasV1: Readonly<
  Record<PluginAvailabilityActionIdV1, z.ZodMiniType>
> = Object.freeze({
  'account.plugins.availability.intent.read': PluginAvailabilityIntentReadActionOutputV1Schema,
  'account.plugins.availability.intents.list': PluginAvailabilityIntentsListActionOutputV1Schema,
  'account.plugins.availability.intent.set': PluginAvailabilityIntentSetActionOutputV1Schema,
  'account.plugins.availability.collectionWriters.claim': PluginAvailabilityCollectionWritersClaimActionOutputV1Schema,
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
  'account.plugins.availability.packageAsset.remove': PluginAvailabilityPackageAssetRemoveActionOutputV1Schema,
});
