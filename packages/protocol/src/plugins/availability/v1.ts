import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ManagedResourceDependencyV1Schema } from '../../machines/managed/managedDependencyV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { SERVER_IDENTITY_ID_PATTERN } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import { PluginCollectionContractRefV1Schema } from '../data/collectionContractRefV1.js';
import { PluginManifestV2Schema } from '../manifest/v2.js';
import { PluginDeclaredUiEntriesV1Schema } from '../../daemon/contributionRegistryProjection.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginUiArtifactIdV2Schema,
  PluginUiArtifactsManifestV2Schema,
  type PluginUiArtifactsManifestV2,
} from '../ui/uiArtifactsManifest.js';
import { PluginUiArtifactDigestV1Schema } from '../ui/artifactIntegrity.js';
import {
  isPackageAssetArchiveDescriptorDeclaredByManifestV1,
  PackageAssetArchiveDescriptorV1Schema,
  normalizePackageAssetArchiveDescriptorV1,
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

const ServerIdentityIdSchema = lazyZodSchema(() => z.string().trim().regex(SERVER_IDENTITY_ID_PATTERN));
const ContributionIdSchema = lazyZodSchema(() => z.string().trim().min(1).max(256));
const ArtifactTierSchema = lazyZodSchema(() => z.enum(['declarative', 'hostedWeb', 'reactNative']));
const ArtifactPlatformSchema = lazyZodSchema(() => z.enum(['web', 'ios', 'android']));
const MachineMaterializationRevisionSchema = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const TimestampMsSchema = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

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
 * Availability consumes the canonical manifest parser's output. The manifest schema
 * already rejects source/private locator fields; source verification remains at the
 * acquisition owner and is deliberately not persisted here.
 */
export const PluginPortableReleaseManifestV1Schema: typeof PluginManifestV2Schema = PluginManifestV2Schema;
export type PluginPortableReleaseManifestV1 = z.infer<typeof PluginPortableReleaseManifestV1Schema>;

/**
 * The generated compatibility input published beside an immutable
 * package version. It deliberately contains only canonical manifest and UI
 * artifact facts: host/SDK build provenance is not an author-controlled
 * compatibility switch and therefore has no field here.
 */
export const PluginCompatibilityProjectionV1Schema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  manifest: PluginPortableReleaseManifestV1Schema,
  uiArtifacts: PluginUiArtifactsManifestV2Schema,
}).strict());
export type PluginCompatibilityProjectionV1 = z.infer<typeof PluginCompatibilityProjectionV1Schema>;

/**
 * Generates the only comparison payload from the canonical manifest and
 * generated UI inventory already admitted by package build/staging owners.
 */
export function createPluginCompatibilityProjectionV1(input: Readonly<{
  manifest: PluginPortableReleaseManifestV1;
  uiArtifacts: PluginUiArtifactsManifestV2;
}>): PluginCompatibilityProjectionV1 {
  return PluginCompatibilityProjectionV1Schema.parse({
    version: 1,
    manifest: input.manifest,
    uiArtifacts: input.uiArtifacts,
  });
}

export function pluginCompatibilityProjectionEqualV1(
  left: unknown,
  right: unknown,
): boolean {
  return createCanonicalJsonSigningInput(PluginCompatibilityProjectionV1Schema.parse(left))
    === createCanonicalJsonSigningInput(PluginCompatibilityProjectionV1Schema.parse(right));
}

/**
 * Immutable release slots retain only compatibility facts emitted by the
 * generated UI artifact. Current host app/channel/capability facts are
 * transient adoption inputs and must not become portable release identity.
 */
export const PluginUiReleaseSlotV1Schema = lazyZodSchema(() => z.object({
  contributionId: ContributionIdSchema,
  artifactId: PluginUiArtifactIdV2Schema,
  tier: ArtifactTierSchema,
  platform: ArtifactPlatformSchema,
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostUiApiRange: z.string().trim().min(1),
}).strict().superRefine((value, context) => {
  if (value.tier === 'hostedWeb' && value.platform !== 'web') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['platform'],
      message: 'Hosted-web UI slots are platform-web archives.',
    });
  }
  if (value.tier === 'declarative' && value.platform !== 'web') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['platform'],
      message: 'Declarative UI slots are platform-web archives.',
    });
  }
}));
export type PluginUiReleaseSlotV1 = z.infer<typeof PluginUiReleaseSlotV1Schema>;

function collectionContractKey(value: z.infer<typeof PluginCollectionContractRefV1Schema>): string {
  return `${value.pluginId}\u0000${value.collectionId}`;
}

function uiSlotKey(value: Readonly<{
  contributionId: string;
  artifactId: string;
  tier: 'declarative' | 'hostedWeb' | 'reactNative';
  platform: 'web' | 'ios' | 'android';
}>): string {
  return `${value.contributionId}\u0000${value.artifactId}\u0000${value.tier}\u0000${value.platform}`;
}

export const PluginReleaseFactsV1Schema = lazyZodSchema(() => z.object({
  ref: PluginReleaseRefV1Schema,
  archiveDigestSha256: PluginUiArtifactDigestV1Schema,
  normalizedManifest: PluginPortableReleaseManifestV1Schema,
  collectionContracts: z.array(PluginCollectionContractRefV1Schema).readonly(),
  uiSlots: z.array(PluginUiReleaseSlotV1Schema).readonly(),
  /** The only package bytes eligible for Account Artifact publication. */
  packageAssetArchive: PackageAssetArchiveDescriptorV1Schema,
}).strict().superRefine((value, context) => {
  if (
    value.normalizedManifest.id !== value.ref.pluginId
    || value.normalizedManifest.version !== value.ref.version
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['normalizedManifest'],
      message: 'Portable manifest id and version must match the release coordinate.',
    });
  }
  if (!isPackageAssetArchiveDescriptorDeclaredByManifestV1({
    manifest: value.normalizedManifest,
    descriptor: value.packageAssetArchive,
  })) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['packageAssetArchive', 'resources'],
      message: 'Package Asset archive resources must exactly match manifest-declared packaged assets.',
    });
  }
  const collectionKeys = new Set<string>();
  value.collectionContracts.forEach((contract, index) => {
    if (contract.pluginId !== value.ref.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['collectionContracts', index, 'pluginId'],
        message: 'Release collection contracts must belong to the release plugin.',
      });
    }
    const key = collectionContractKey(contract);
    if (collectionKeys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
        path: ['uiSlots', index],
        message: 'Release UI slots must be unique by contribution, tier, and platform.',
      });
    }
    slotKeys.add(key);
  });
}));
export type PluginReleaseFactsV1 = z.infer<typeof PluginReleaseFactsV1Schema>;

function cloneReleaseFactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneReleaseFactValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
      [key, cloneReleaseFactValue(entry)]
    )));
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
 * Release facts become immutable publication and conflict-comparison input.
 * Copy the complete schema-owned graph before recursively freezing it so no
 * caller or registry reader can mutate a later canonical signing payload.
 */
function snapshotPluginReleaseFactsV1(value: PluginReleaseFactsV1): PluginReleaseFactsV1 {
  return deepFreezeReleaseFactValue(PluginReleaseFactsV1Schema.parse(
    cloneReleaseFactValue(value),
  ));
}

/**
 * Produces the one comparison representation for immutable release facts. It does
 * not invent a release digest or identity: callers still use pluginId@version.
 */
export function normalizePluginReleaseFactsV1(input: unknown): PluginReleaseFactsV1 {
  const parsed = PluginReleaseFactsV1Schema.parse(input);
  return snapshotPluginReleaseFactsV1({
    ...parsed,
    ref: { ...parsed.ref },
    collectionContracts: Object.freeze([...parsed.collectionContracts]
      .sort((left, right) => collectionContractKey(left).localeCompare(collectionContractKey(right)))
      .map((contract) => ({ ...contract }))),
    uiSlots: Object.freeze([...parsed.uiSlots]
      .sort((left, right) => uiSlotKey(left).localeCompare(uiSlotKey(right)))
      .map((slot) => ({ ...slot }))),
    packageAssetArchive: normalizePackageAssetArchiveDescriptorV1(parsed.packageAssetArchive),
  });
}

/**
 * Compares the immutable facts bound to one public `pluginId@version` release.
 * This intentionally does not create a digest or an alternate release identity:
 * the canonical JSON comparison is only the first-publication conflict guard.
 */
export function pluginReleaseFactsEqualV1(
  left: unknown,
  right: unknown,
): boolean {
  return createCanonicalJsonSigningInput(normalizePluginReleaseFactsV1(left))
    === createCanonicalJsonSigningInput(normalizePluginReleaseFactsV1(right));
}

export const PluginAccountPluginIntentV1Schema = lazyZodSchema(() => z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  desiredVersion: PluginReleaseVersionV1Schema.nullable(),
  enabled: z.boolean(),
  offlineUiHosting: z.enum(['disabled', 'enabled']),
  writableCollections: z.array(PluginCollectionContractRefV1Schema),
  revision: z.string().trim().min(1).max(128),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  value.writableCollections.forEach((contract, index) => {
    if (contract.pluginId !== value.pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writableCollections', index, 'pluginId'],
        message: 'Intent writable collections must belong to the selected plugin.',
      });
    }
    const key = collectionContractKey(contract);
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writableCollections', index],
        message: 'Intent writable collections must be unique by plugin and collection.',
      });
    }
    keys.add(key);
  });
}));
export type PluginAccountPluginIntentV1 = z.infer<typeof PluginAccountPluginIntentV1Schema>;

export const PluginUiArtifactHostingCapabilityV1Schema = lazyZodSchema(() => z.union([
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    maxArtifactBytes: z.number().int().positive(),
    maxAccountBytes: z.number().int().positive(),
  }).strict().refine(
    (value) => value.maxAccountBytes >= value.maxArtifactBytes,
    'The Account hosting limit must admit one artifact.',
  ),
]));
export type PluginUiArtifactHostingCapabilityV1 = z.infer<typeof PluginUiArtifactHostingCapabilityV1Schema>;

export const PluginAccountPluginUiArtifactLinkV1Schema = lazyZodSchema(() => z.object({
  release: PluginReleaseRefV1Schema,
  contributionId: ContributionIdSchema,
  artifactId: PluginUiArtifactIdV2Schema,
  tier: ArtifactTierSchema,
  platform: ArtifactPlatformSchema,
  accountArtifactId: z.string().uuid(),
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostUiApiRange: z.string().trim().min(1),
}).strict());
export type PluginAccountPluginUiArtifactLinkV1 = z.infer<typeof PluginAccountPluginUiArtifactLinkV1Schema>;

/**
 * A protected Account Artifact is the only durable carrier for the immutable
 * package-asset archive authorized by a release. The descriptor remains the
 * release-owned authority; the link names its Account-local byte carrier.
 */
export const PluginAccountPluginPackageAssetLinkV1Schema = lazyZodSchema(() => z.object({
  release: PluginReleaseRefV1Schema,
  artifactId: z.string().uuid(),
  descriptor: PackageAssetArchiveDescriptorV1Schema,
}).strict());
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

export const PluginMachineUiArtifactV1Schema = lazyZodSchema(() => z.object({
  contributionId: ContributionIdSchema,
  artifactId: PluginUiArtifactIdV2Schema,
  tier: ArtifactTierSchema,
  platform: ArtifactPlatformSchema,
  artifactDigest: PluginUiArtifactDigestV1Schema,
  hostUiApiRange: z.string().trim().min(1),
}).strict());
export type PluginMachineUiArtifactV1 = z.infer<typeof PluginMachineUiArtifactV1Schema>;

export const PluginMachineMaterializationV1Schema = lazyZodSchema(() => z.object({
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
  declaredManifest: PluginPortableReleaseManifestV1Schema.optional(),
  declaredUiEntries: PluginDeclaredUiEntriesV1Schema.optional(),
  archiveDigestSha256: PluginUiArtifactDigestV1Schema.optional(),
  uiArtifacts: z.array(PluginMachineUiArtifactV1Schema).readonly(),
  enabled: z.boolean(),
  trustState: z.enum(['trusted', 'untrusted', 'revoked']),
  observedAt: TimestampMsSchema,
}).strict().superRefine((value, context) => {
  if (value.declaredManifest && (value.declaredManifest.id !== value.pluginId || value.declaredManifest.version !== value.version)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['declaredManifest'], message: 'Installed declaration must match its plugin and version.' });
  }
  for (const [entryId, entry] of Object.entries(value.declaredUiEntries ?? {})) {
    if (entry.id !== entryId || entry.pluginId !== value.pluginId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['declaredUiEntries', entryId], message: 'Installed UI declaration must match its entry and plugin identity.' });
    }
  }
  if ((value.sourceClass === 'localPath' || value.sourceClass === 'bundledFirstParty') && value.portableRelease) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['portableRelease'],
      message: 'Daemon-selected local and bundled plugins are machine-bound and cannot claim a portable release.',
    });
  }
  const keys = new Set<string>();
  value.uiArtifacts.forEach((artifact, index) => {
    const key = uiSlotKey(artifact);
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uiArtifacts', index],
        message: 'Machine UI artifacts must be unique by contribution, tier, and platform.',
      });
    }
    keys.add(key);
  });
}));
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
    uiArtifacts: materialization.uiArtifacts,
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
export const PluginMachineMaterializationSnapshotV1Schema = lazyZodSchema(() => z.object({
  serverIdentityId: ServerIdentityIdSchema,
  machineId: PluginMachineMaterializationMachineIdV1Schema,
  materializations: z.array(PluginMachineMaterializationV1Schema).readonly(),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.materializations.forEach((materialization, index) => {
    if (
      materialization.serverIdentityId !== value.serverIdentityId
      || materialization.machineId !== value.machineId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['materializations', index],
        message: 'Every materialization must belong to the reported server identity and machine.',
      });
    }
    if (ids.has(materialization.materializationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['materializations', index, 'materializationId'],
        message: 'A snapshot cannot report duplicate installation epochs.',
      });
    }
    ids.add(materialization.materializationId);
  });
}));
export type PluginMachineMaterializationSnapshotV1 = z.infer<typeof PluginMachineMaterializationSnapshotV1Schema>;

/**
 * Account-level availability facts are read separately from machine inventory:
 * intent/release/link data controls which immutable Artifact is current, while
 * a complete machine snapshot only reports exact installation correspondence.
 */
export const PluginAccountAvailabilityIntentReadResponseV1Schema = lazyZodSchema(() => z.object({
  availabilityCursor: MachineMaterializationRevisionSchema,
  hostingCapability: PluginUiArtifactHostingCapabilityV1Schema,
  intent: PluginAccountPluginIntentV1Schema.nullable(),
  release: PluginReleaseFactsV1Schema.nullable(),
  uiArtifacts: z.array(PluginAccountPluginUiArtifactLinkV1Schema).readonly(),
  packageAssets: z.array(PluginAccountPluginPackageAssetLinkV1Schema).readonly(),
  managedResources: z.array(ManagedResourceDependencyV1Schema).readonly().optional(),
  managedResourcesReviewed: z.boolean().optional(),
}).strict());
export type PluginAccountAvailabilityIntentReadResponseV1 =
  z.infer<typeof PluginAccountAvailabilityIntentReadResponseV1Schema>;

/**
 * The Account bootstrap batch reuses the exact intent.read projection, including
 * release and Artifact facts. Failed reads remain explicit per plugin; neither
 * a partial result nor a missing intent can fabricate a current declaration.
 */
export const PluginAccountAvailabilityIntentsListResponseV1Schema = lazyZodSchema(() => z.object({
  availabilityCursor: MachineMaterializationRevisionSchema,
  pluginIds: z.array(asProtocolZod(PluginIdSchema)).readonly(),
  nextCursor: asProtocolZod(PluginIdSchema).nullable().optional(),
  intentReads: z.array(z.object({
    pluginId: asProtocolZod(PluginIdSchema),
    response: PluginAccountAvailabilityIntentReadResponseV1Schema,
  }).strict()).readonly(),
  failedPluginIds: z.array(asProtocolZod(PluginIdSchema)).readonly(),
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.pluginIds.length; index += 1) {
    const previous = value.pluginIds[index - 1]!;
    const pluginId = value.pluginIds[index]!;
    if (previous >= pluginId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pluginIds', index],
        message: 'Account Availability intent ids must be sorted and unique.',
      });
    }
  }
  const accountedPluginIds = new Set<string>();
  for (const [index, entry] of value.intentReads.entries()) {
    if (accountedPluginIds.has(entry.pluginId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['intentReads', index, 'pluginId'],
        message: 'Account Availability reads must name each plugin once.' });
    }
    accountedPluginIds.add(entry.pluginId);
  }
  for (const [index, pluginId] of value.failedPluginIds.entries()) {
    if (accountedPluginIds.has(pluginId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['failedPluginIds', index],
        message: 'A failed plugin cannot also have a successful read or appear twice.' });
    }
    accountedPluginIds.add(pluginId);
  }
  for (const [index, pluginId] of value.pluginIds.entries()) {
    if (!accountedPluginIds.has(pluginId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['pluginIds', index],
        message: 'Every discovered intent must have a successful or failed read.' });
    }
  }
}));
export type PluginAccountAvailabilityIntentsListResponseV1 =
  z.infer<typeof PluginAccountAvailabilityIntentsListResponseV1Schema>;

/**
 * Reads immutable Account release facts by exact coordinate. Selection intent
 * remains a separate owner, while the cursor tells consumers whether the
 * Account Availability projection advanced around the read.
 */
export const PluginAccountAvailabilityReleaseReadResponseV1Schema = lazyZodSchema(() => z.object({
  availabilityCursor: MachineMaterializationRevisionSchema,
  facts: PluginReleaseFactsV1Schema,
}).strict());
export type PluginAccountAvailabilityReleaseReadResponseV1 =
  z.infer<typeof PluginAccountAvailabilityReleaseReadResponseV1Schema>;

export type PluginAccountAvailabilityMaterializationsReadResponseV1 = Readonly<{
  availabilityCursor: number;
  snapshots: readonly PluginMachineMaterializationSnapshotV1[];
  inventoryComplete?: boolean;
  releases?: readonly PluginReleaseFactsV1[];
}>;
export const PluginAccountAvailabilityMaterializationsReadResponseV1Schema: z.ZodType<PluginAccountAvailabilityMaterializationsReadResponseV1> = lazyZodSchema(() => z.object({
  availabilityCursor: MachineMaterializationRevisionSchema,
  snapshots: z.array(PluginMachineMaterializationSnapshotV1Schema).readonly(),
  /** Omitted machine rows are unknown if any complete machine snapshot could not be read. */
  inventoryComplete: z.boolean().optional(),
  /** Immutable facts for reported portable coordinates, independent of enabled selection intent. */
  releases: z.array(PluginReleaseFactsV1Schema).readonly().optional(),
}).strict());

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
