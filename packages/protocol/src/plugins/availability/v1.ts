export {
  PluginMachineMaterializationSnapshotV1LoadSchema,
  PluginMachineMaterializationV1LoadSchema,
  PluginReleaseFactsV1LoadSchema,
} from './load.js';
import {
  PluginMachineMaterializationSnapshotV1LoadSchema,
  PluginMachineMaterializationV1LoadSchema,
  PluginReleaseFactsV1LoadSchema,
} from './load.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ManagedResourceDependencyV1Schema } from '../../machines/managed/managedDependencyV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";
import { preparePluginContributionPointDeclarationsV1 } from '../contributions/targetedContributions.js';

import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { SERVER_IDENTITY_ID_PATTERN } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import { PluginCollectionContractRefV1Schema, pluginCollectionContractKeyV1 as collectionContractKey } from '../data/collectionContractRefV1.js';
import { PluginAccountPluginIntentV1Schema, type PluginAccountPluginIntentV1 } from './accountIntentV1.js';
export { PluginAccountPluginIntentV1Schema, type PluginAccountPluginIntentV1 } from './accountIntentV1.js';
import { PluginPortableReleaseManifestV1Schema } from './compatibilityProjectionV1.js';
export {
  PluginPortableReleaseManifestV1Schema,
  PluginCompatibilityProjectionV1Schema,
  createPluginCompatibilityProjectionV1,
  pluginCompatibilityProjectionEqualV1,
  type PluginPortableReleaseManifestV1,
  type PluginCompatibilityProjectionV1,
} from './compatibilityProjectionV1.js';
import { PluginDeclaredUiEntriesV1Schema } from '../../daemon/contributionRegistryProjection.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginUiArtifactIdV2Schema,
  PluginUiArtifactsManifestEntryV2Schema,
} from '../ui/uiArtifactsManifest.js';
import { PluginUiArtifactDigestV1Schema } from '../ui/artifactIntegrity.js';
import {
  isPackageAssetArchiveDescriptorDeclaredByManifestV1,
  PackageAssetArchiveDescriptorV1Schema,
} from './packageAssetV1.js';
import {
  PluginMachineMaterializationIdV1Schema,
  PluginMachineMaterializationMachineIdV1Schema,
  PluginMachineMaterializationRefV1Schema,
  type PluginMachineMaterializationRefV1,
} from './materializationRefV1.js';
import {
  PluginReleaseRefV1Schema,
  PluginReleaseVersionV1Schema,
} from './releaseRefV1.js';


export {
  PluginMachineMaterializationRefV1Schema,
  type PluginMachineMaterializationRefV1,
} from './materializationRefV1.js';

const ServerIdentityIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.regex(SERVER_IDENTITY_ID_PATTERN)));
const ContributionIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const ArtifactTierSchema = lazyZodSchema(() => z.enum(['declarative', 'hostedWeb', 'reactNative']));
const ArtifactPlatformSchema = lazyZodSchema(() => z.enum(['web', 'ios', 'android']));
const MachineMaterializationRevisionSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));
const TimestampMsSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));

/**
 * Intent discovery pages the canonical read projections. This is a processing
 * page size, not a limit on the Account census or its encoded bytes.
 */
export const PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE = 200;

export {
  MAX_PLUGIN_RELEASE_VERSION_BYTES,
  PluginReleaseRefV1Schema,
  PluginReleaseVersionV1Schema,
  type PluginReleaseRefV1,
} from './releaseRefV1.js';

/**
 * Immutable release slots retain only compatibility facts emitted by the
 * generated UI artifact. Current host app/channel/capability facts are
 * transient adoption inputs and must not become portable release identity.
 */
export const PluginUiReleaseSlotV1Schema = lazyZodSchema(() => z.strictObject({
  contributionId: ContributionIdSchema,
  artifactId: PluginUiArtifactIdV2Schema,
  tier: ArtifactTierSchema,
  platform: ArtifactPlatformSchema,
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostUiApiRange: z.string().check(z.trim(), z.minLength(1)),
  /** Exact compiler graph for portable activation without a projecting Machine. */
  artifactGraph: z.optional(PluginUiArtifactsManifestEntryV2Schema),
}).check(z.superRefine((value, context) => {
  if (value.artifactGraph && (value.artifactGraph.artifactId !== value.artifactId
    || value.artifactGraph.tier !== value.tier
    || value.artifactGraph.digest !== value.artifactDigest
    || value.artifactGraph.hostUiApiRange !== value.hostUiApiRange)) {
    context.addIssue({ code: 'custom', path: ['artifactGraph'], message: 'Compiler graph must match the exact release slot.' });
  }
  if (value.tier === 'hostedWeb' && value.platform !== 'web') {
    context.addIssue({
      code: "custom",
      path: ['platform'],
      message: 'Hosted-web UI slots are platform-web archives.',
    });
  }
  if (value.tier === 'declarative' && value.platform !== 'web') {
    context.addIssue({
      code: "custom",
      path: ['platform'],
      message: 'Declarative UI slots are platform-web archives.',
    });
  }
})));
export type PluginUiReleaseSlotV1 = z.infer<typeof PluginUiReleaseSlotV1Schema>;

function uiSlotKey(value: Readonly<{
  contributionId: string;
  artifactId: string;
  tier: 'declarative' | 'hostedWeb' | 'reactNative';
  platform: 'web' | 'ios' | 'android';
}>): string {
  return `${value.contributionId}\u0000${value.artifactId}\u0000${value.tier}\u0000${value.platform}`;
}

export const PluginReleaseFactsV1Schema = lazyZodSchema(() => z.strictObject({
  ref: PluginReleaseRefV1Schema,
  archiveDigestSha256: PluginUiArtifactDigestV1Schema,
  normalizedManifest: PluginPortableReleaseManifestV1Schema,
  collectionContracts: z.readonly(z.array(PluginCollectionContractRefV1Schema)),
  uiSlots: z.readonly(z.array(PluginUiReleaseSlotV1Schema)),
  /** The only package bytes eligible for Account Artifact publication. */
  packageAssetArchive: PackageAssetArchiveDescriptorV1Schema,
}).check(z.superRefine((value, context) => {
  if (
    value.normalizedManifest.id !== value.ref.pluginId
    || value.normalizedManifest.version !== value.ref.version
  ) {
    context.addIssue({
      code: "custom",
      path: ['normalizedManifest'],
      message: 'Portable manifest id and version must match the release coordinate.',
    });
  }
  if (!isPackageAssetArchiveDescriptorDeclaredByManifestV1({
    manifest: value.normalizedManifest,
    descriptor: value.packageAssetArchive,
  })) {
    context.addIssue({
      code: "custom",
      path: ['packageAssetArchive', 'resources'],
      message: 'Package Asset archive resources must exactly match manifest-declared packaged assets.',
    });
  }
  const collectionKeys = new Set<string>();
  value.collectionContracts.forEach((contract, index) => {
    if (contract.pluginId !== value.ref.pluginId) {
      context.addIssue({
        code: "custom",
        path: ['collectionContracts', index, 'pluginId'],
        message: 'Release collection contracts must belong to the release plugin.',
      });
    }
    const key = collectionContractKey(contract);
    if (collectionKeys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ['collectionContracts', index],
        message: 'Release collection contracts must be unique by plugin and collection.',
      });
    }
    collectionKeys.add(key);
  });
  const slotKeys = new Set<string>();
  value.uiSlots.forEach((slot, index) => {
    const key = uiSlotKey(slot);
    if (slotKeys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ['uiSlots', index],
        message: 'Release UI slots must be unique by contribution, tier, and platform.',
      });
    }
    slotKeys.add(key);
  });
})));
export type PluginReleaseFactsV1 = z.infer<typeof PluginReleaseFactsV1Schema>;

function cloneReleaseFactValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneReleaseFactValue(entry)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
      [key, cloneReleaseFactValue(entry)]
    ))) as T;
  }
  return value;
}

function deepFreezeReleaseFactValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreezeReleaseFactValue(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Prepares already-validated release facts for immutable publication. Copy the
 * complete schema-owned graph so a caller cannot mutate a published snapshot.
 * Collection and UI slots have canonical key order; the Asset descriptor's
 * schema already requires canonical resource order.
 */
export function snapshotPluginReleaseFactsV1(value: PluginReleaseFactsV1): PluginReleaseFactsV1 {
  const copied = cloneReleaseFactValue(value);
  return deepFreezeReleaseFactValue({
    ...copied,
    normalizedManifest: { ...copied.normalizedManifest,
      contributes: preparePluginContributionPointDeclarationsV1(copied.normalizedManifest.contributes),
    },
    collectionContracts: [...copied.collectionContracts]
      .sort((left, right) => collectionContractKey(left).localeCompare(collectionContractKey(right))),
    uiSlots: [...copied.uiSlots]
      .sort((left, right) => uiSlotKey(left).localeCompare(uiSlotKey(right))),
  });
}

/** Strict ingress admission followed by the canonical immutable preparation. */
export function normalizePluginReleaseFactsV1(input: unknown): PluginReleaseFactsV1 {
  return snapshotPluginReleaseFactsV1(PluginReleaseFactsV1Schema.parse(input));
}

/**
 * Compares canonically prepared facts at the first-publication conflict guard.
 * Unknown input belongs at the release schema/normalizer, not this comparison.
 */
export function pluginReleaseFactsEqualV1(
  left: PluginReleaseFactsV1,
  right: PluginReleaseFactsV1,
): boolean {
  return sameStrictJsonValue(left, right);
}

export const PluginUiArtifactHostingCapabilityV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    maxArtifactBytes: z.number().check(z.int(), z.positive()),
    maxAccountBytes: z.number().check(z.int(), z.positive()),
  }).check(z.refine((value) => value.maxAccountBytes >= value.maxArtifactBytes, 'The Account hosting limit must admit one artifact.')),
]));
export type PluginUiArtifactHostingCapabilityV1 = z.infer<typeof PluginUiArtifactHostingCapabilityV1Schema>;

export const PluginAccountPluginUiArtifactLinkV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
  contributionId: ContributionIdSchema,
  artifactId: PluginUiArtifactIdV2Schema,
  tier: ArtifactTierSchema,
  platform: ArtifactPlatformSchema,
  accountArtifactId: z.string().check(z.uuid()),
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostUiApiRange: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginAccountPluginUiArtifactLinkV1 = z.infer<typeof PluginAccountPluginUiArtifactLinkV1Schema>;

/**
 * A protected Account Artifact is the only durable carrier for the immutable
 * package-asset archive authorized by a release. The descriptor remains the
 * release-owned authority; the link names its Account-local byte carrier.
 */
export const PluginAccountPluginPackageAssetLinkV1Schema = lazyZodSchema(() => z.strictObject({
  release: PluginReleaseRefV1Schema,
  artifactId: z.string().check(z.uuid()),
  descriptor: PackageAssetArchiveDescriptorV1Schema,
}));
export type PluginAccountPluginPackageAssetLinkV1 =
  z.infer<typeof PluginAccountPluginPackageAssetLinkV1Schema>;

/**
 * Release slots carry only portable build compatibility. A hosted Artifact
 * link additionally records the transient host/adoption facts that produced
 * it, so consumers must compare the two representations through this one
 * bridge rather than treating the link key as release identity.
 */
export function isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(
  slot: PluginUiReleaseSlotV1,
  link: PluginAccountPluginUiArtifactLinkV1,
): boolean {
  return link.contributionId === slot.contributionId
    && link.artifactId === slot.artifactId
    && link.tier === slot.tier
    && link.platform === slot.platform
    && link.artifactDigest === slot.artifactDigest
    && link.hostUiApiRange === slot.hostUiApiRange;
}

export const PluginMachineUiArtifactV1Schema = lazyZodSchema(() => z.strictObject({
  contributionId: ContributionIdSchema,
  artifactId: PluginUiArtifactIdV2Schema,
  tier: ArtifactTierSchema,
  platform: ArtifactPlatformSchema,
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostUiApiRange: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginMachineUiArtifactV1 = z.infer<typeof PluginMachineUiArtifactV1Schema>;

/** Release slots may carry an executable graph; Machine observations carry only these facts. */
export function projectPluginMachineUiArtifactV1(artifact: PluginMachineUiArtifactV1): PluginMachineUiArtifactV1 {
  return Object.freeze({
    contributionId: artifact.contributionId,
    artifactId: artifact.artifactId,
    tier: artifact.tier,
    platform: artifact.platform,
    artifactDigest: artifact.artifactDigest,
    hostUiApiRange: artifact.hostUiApiRange,
  });
}

export const PluginMachineMaterializationV1Schema = lazyZodSchema(() => z.strictObject({
  serverIdentityId: ServerIdentityIdSchema,
  machineId: PluginMachineMaterializationMachineIdV1Schema,
  materializationId: PluginMachineMaterializationIdV1Schema,
  pluginId: asProtocolZod(PluginIdSchema),
  version: PluginReleaseVersionV1Schema,
  /**
   * `bundledFirstParty` and `localPath` are daemon-selected and machine-bound:
   * they never claim a portable release. Their Account currentness comes from
   * the release-less intent declaration their host claims.
   */
  sourceClass: z.enum(['registryPackage', 'versionedArchive', 'localPath', 'bundledFirstParty']),
  portableRelease: z.boolean(),
  /** Admitted installed declaration for discovery; never an execution grant. */
  declaredManifest: zMini.optional(PluginPortableReleaseManifestV1Schema),
  declaredUiEntries: zMini.optional(PluginDeclaredUiEntriesV1Schema),
  archiveDigestSha256: zMini.optional(PluginUiArtifactDigestV1Schema),
  uiArtifacts: z.readonly(z.array(PluginMachineUiArtifactV1Schema)),
  enabled: z.boolean(),
  trustState: z.enum(['trusted', 'untrusted', 'revoked']),
  observedAt: TimestampMsSchema,
}).check(z.superRefine((value, context) => {
  if (value.declaredManifest && (value.declaredManifest.id !== value.pluginId || value.declaredManifest.version !== value.version)) {
    context.addIssue({ code: "custom", path: ['declaredManifest'], message: 'Installed declaration must match its plugin and version.' });
  }
  for (const [entryId, entry] of Object.entries(value.declaredUiEntries ?? {})) {
    if (entry.id !== entryId || entry.pluginId !== value.pluginId) {
      context.addIssue({ code: "custom", path: ['declaredUiEntries', entryId], message: 'Installed UI declaration must match its entry and plugin identity.' });
    }
  }
  if ((value.sourceClass === 'localPath' || value.sourceClass === 'bundledFirstParty') && value.portableRelease) {
    context.addIssue({
      code: "custom",
      path: ['portableRelease'],
      message: 'Daemon-selected local and bundled plugins are machine-bound and cannot claim a portable release.',
    });
  }
  const keys = new Set<string>();
  value.uiArtifacts.forEach((artifact, index) => {
    const key = uiSlotKey(artifact);
    if (keys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ['uiArtifacts', index],
        message: 'Machine UI artifacts must be unique by contribution, tier, and platform.',
      });
    }
    keys.add(key);
  });
})));
export type PluginMachineMaterializationV1 = z.infer<typeof PluginMachineMaterializationV1Schema>;

/**
 * The installation facts the server reports and persists. Live daemon
 * declarations stay with their source and are not server census semantics.
 */
export function projectPluginMachineMaterializationReportFactsV1(
  materialization: PluginMachineMaterializationV1,
): Readonly<Omit<PluginMachineMaterializationV1, 'declaredManifest' | 'declaredUiEntries'>> {
  return Object.freeze({
    serverIdentityId: materialization.serverIdentityId,
    machineId: materialization.machineId,
    materializationId: materialization.materializationId,
    pluginId: materialization.pluginId,
    version: materialization.version,
    sourceClass: materialization.sourceClass,
    portableRelease: materialization.portableRelease,
    ...(materialization.archiveDigestSha256 !== undefined
      ? { archiveDigestSha256: materialization.archiveDigestSha256 }
      : {}),
    uiArtifacts: Object.freeze(materialization.uiArtifacts.map(projectPluginMachineUiArtifactV1)),
    enabled: materialization.enabled,
    trustState: materialization.trustState,
    observedAt: materialization.observedAt,
  });
}

/**
 * The Account release is the canonical immutable-content owner. Portable
 * materializations carry their installed coordinate and immutable digest
 * evidence; correspondence resolves that evidence against the Account release.
 */
export function isExactPluginMachineMaterializationReleaseCorrespondenceV1(
  materialization: PluginMachineMaterializationV1,
  release: PluginReleaseFactsV1,
): boolean {
  if (
    !materialization.portableRelease
    || materialization.pluginId !== release.ref.pluginId
    || materialization.version !== release.ref.version
    || materialization.archiveDigestSha256 !== release.archiveDigestSha256
  ) {
    return false;
  }
  const releaseSlotsByKey = new Map(
    release.uiSlots.map((slot) => [uiSlotKey(slot), slot]),
  );
  if (materialization.uiArtifacts.length !== releaseSlotsByKey.size) return false;
  return materialization.uiArtifacts.every((artifact) => {
    const slot = releaseSlotsByKey.get(uiSlotKey(artifact));
    return slot?.artifactDigest === artifact.artifactDigest
      && slot.hostUiApiRange === artifact.hostUiApiRange;
  });
}

/**
 * The portable execution reference deliberately excludes server identity. The
 * caller-owned execution-origin record carries serverIdentityId beside this ref.
 */
export const PluginMachineMaterializationSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  serverIdentityId: ServerIdentityIdSchema,
  machineId: PluginMachineMaterializationMachineIdV1Schema,
  materializations: z.readonly(z.array(PluginMachineMaterializationV1Schema)),
}).check(z.superRefine((value, context) => {
  const ids = new Set<string>();
  value.materializations.forEach((materialization, index) => {
    if (
      materialization.serverIdentityId !== value.serverIdentityId
      || materialization.machineId !== value.machineId
    ) {
      context.addIssue({
        code: "custom",
        path: ['materializations', index],
        message: 'Every materialization must belong to the reported server identity and machine.',
      });
    }
    if (ids.has(materialization.materializationId)) {
      context.addIssue({
        code: "custom",
        path: ['materializations', index, 'materializationId'],
        message: 'A snapshot cannot report duplicate installation epochs.',
      });
    }
    ids.add(materialization.materializationId);
  });
})));
export type PluginMachineMaterializationSnapshotV1 = z.infer<typeof PluginMachineMaterializationSnapshotV1Schema>;

/**
 * Account-level availability facts are read separately from machine inventory:
 * intent/release/link data controls which immutable Artifact is current, while
 * a complete machine snapshot only reports exact installation correspondence.
 */
export const PluginAccountAvailabilityIntentReadResponseV1Schema = lazyZodSchema(() => z.strictObject({
  availabilityCursor: MachineMaterializationRevisionSchema,
  hostingCapability: PluginUiArtifactHostingCapabilityV1Schema,
  intent: z.nullable(PluginAccountPluginIntentV1Schema),
  release: z.nullable(PluginReleaseFactsV1LoadSchema),
  uiArtifacts: z.readonly(z.array(PluginAccountPluginUiArtifactLinkV1Schema)),
  packageAssets: z.readonly(z.array(PluginAccountPluginPackageAssetLinkV1Schema)),
  managedResources: z.optional(z.readonly(z.array(ManagedResourceDependencyV1Schema))),
  managedResourcesReviewed: z.optional(z.boolean()),
}));
export type PluginAccountAvailabilityIntentReadResponseV1 =
  z.infer<typeof PluginAccountAvailabilityIntentReadResponseV1Schema>;

/**
 * The Account bootstrap batch reuses the exact intent.read projection, including
 * release and Artifact facts. Failed reads remain explicit per plugin; neither
 * a partial result nor a missing intent can fabricate a current declaration.
 */
export const PluginAccountAvailabilityIntentsListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  availabilityCursor: MachineMaterializationRevisionSchema,
  pluginIds: z.readonly(z.array(asProtocolZod(PluginIdSchema))),
  nextCursor: zMini.optional(zMini.nullable(asProtocolZod(PluginIdSchema))),
  intentReads: z.readonly(z.array(z.strictObject({
    pluginId: asProtocolZod(PluginIdSchema),
    response: PluginAccountAvailabilityIntentReadResponseV1Schema,
  }))),
  failedPluginIds: z.readonly(z.array(asProtocolZod(PluginIdSchema))),
}).check(z.superRefine((value, context) => {
  for (let index = 1; index < value.pluginIds.length; index += 1) {
    const previous = value.pluginIds[index - 1]!;
    const pluginId = value.pluginIds[index]!;
    if (previous >= pluginId) {
      context.addIssue({
        code: "custom",
        path: ['pluginIds', index],
        message: 'Account Availability intent ids must be sorted and unique.',
      });
    }
  }
  const accountedPluginIds = new Set<string>();
  for (const [index, entry] of value.intentReads.entries()) {
    if (accountedPluginIds.has(entry.pluginId)) {
      context.addIssue({ code: "custom", path: ['intentReads', index, 'pluginId'],
        message: 'Account Availability reads must name each plugin once.' });
    }
    accountedPluginIds.add(entry.pluginId);
  }
  for (const [index, pluginId] of value.failedPluginIds.entries()) {
    if (accountedPluginIds.has(pluginId)) {
      context.addIssue({ code: "custom", path: ['failedPluginIds', index],
        message: 'A failed plugin cannot also have a successful read or appear twice.' });
    }
    accountedPluginIds.add(pluginId);
  }
  for (const [index, pluginId] of value.pluginIds.entries()) {
    if (!accountedPluginIds.has(pluginId)) {
      context.addIssue({ code: "custom", path: ['pluginIds', index],
        message: 'Every discovered intent must have a successful or failed read.' });
    }
  }
})));
export type PluginAccountAvailabilityIntentsListResponseV1 =
  z.infer<typeof PluginAccountAvailabilityIntentsListResponseV1Schema>;

/**
 * Reads immutable Account release facts by exact coordinate. Selection intent
 * remains a separate owner, while the cursor tells consumers whether the
 * Account Availability projection advanced around the read.
 */
export const PluginAccountAvailabilityReleaseReadResponseV1Schema: z.ZodMiniType<PluginAccountAvailabilityReleaseReadResponseV1> = lazyZodSchema(() => z.strictObject({
  availabilityCursor: MachineMaterializationRevisionSchema,
  facts: PluginReleaseFactsV1LoadSchema,
}));
export type PluginAccountAvailabilityReleaseReadResponseV1 = {
  availabilityCursor: number;
  facts: PluginReleaseFactsV1;
};

export type PluginAccountAvailabilityMaterializationsReadResponseV1 = Readonly<{
  availabilityCursor: number;
  snapshots: readonly PluginMachineMaterializationSnapshotV1[];
  inventoryComplete?: boolean;
  releases?: readonly PluginReleaseFactsV1[];
}>;
export const PluginAccountAvailabilityMaterializationsReadResponseV1Schema: z.ZodMiniType<PluginAccountAvailabilityMaterializationsReadResponseV1> = lazyZodSchema(() => z.strictObject({
  availabilityCursor: MachineMaterializationRevisionSchema,
  snapshots: z.readonly(z.array(PluginMachineMaterializationSnapshotV1LoadSchema)),
  /** Omitted machine rows are unknown if any complete machine snapshot could not be read. */
  inventoryComplete: z.optional(z.boolean()),
  /** Immutable facts for reported portable coordinates, independent of enabled selection intent. */
  releases: z.optional(z.readonly(z.array(PluginReleaseFactsV1LoadSchema))),
}));

function normalizePluginMachineMaterializationV1(
  input: PluginMachineMaterializationV1,
): PluginMachineMaterializationV1 {
  const parsed = PluginMachineMaterializationV1Schema.parse(input);
  return Object.freeze({
    ...parsed,
    uiArtifacts: Object.freeze([...parsed.uiArtifacts]
      .sort((left, right) => uiSlotKey(left).localeCompare(uiSlotKey(right)))
      .map((artifact) => Object.freeze({ ...artifact }))),
  });
}

/**
 * Produces the one canonical full-inventory representation used for equal-revision
 * retry comparison. It is not persisted as a second snapshot or fingerprint.
 */
export function normalizePluginMachineMaterializationSnapshotV1(
  input: unknown,
): PluginMachineMaterializationSnapshotV1 {
  const parsed = PluginMachineMaterializationSnapshotV1Schema.parse(input);
  return Object.freeze({
    ...parsed,
    materializations: Object.freeze([...parsed.materializations]
      .sort((left, right) => left.materializationId.localeCompare(right.materializationId))
      .map(normalizePluginMachineMaterializationV1)),
  });
}

export function isPluginMachineMaterializationOnServerIdentityV1(
  materialization: PluginMachineMaterializationV1,
  serverIdentityId: string,
): boolean {
  const parsed = ServerIdentityIdSchema.safeParse(serverIdentityId);
  return parsed.success && materialization.serverIdentityId === parsed.data;
}

defineStoredReadProjection(PluginReleaseFactsV1Schema, () => createStoredReadSchema(PluginReleaseFactsV1LoadSchema));
defineStoredReadProjection(PluginMachineMaterializationV1Schema, () => createStoredReadSchema(PluginMachineMaterializationV1LoadSchema));
defineStoredReadProjection(PluginMachineMaterializationSnapshotV1Schema, () => createStoredReadSchema(PluginMachineMaterializationSnapshotV1LoadSchema));
