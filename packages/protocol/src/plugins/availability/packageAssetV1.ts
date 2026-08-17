import { z } from 'zod';

import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from '../../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { PluginPackagedResourceContributionV2Schema } from '../contributions/v2.js';
import { PluginUiArtifactRelativePathV1Schema } from '../contributions/ui/artifacts.js';
import { PluginManifestV2Schema, type ParsedPluginManifestV2 } from '../manifest/v2.js';
import {
  computePluginUiArtifactSha256DigestV1,
  PluginUiArtifactDigestV1Schema,
  type PluginUiArtifactDigestV1,
} from '../ui/artifactIntegrity.js';

/** One Package Asset archive stays within the incumbent packaged-Resource byte envelope. */
export const MAX_PACKAGE_ASSET_ARCHIVE_RESOURCE_BYTES_V1 = 16 * 1024 * 1024;
export const MAX_PACKAGE_ASSET_ARCHIVE_TOTAL_BYTES_V1 = 64 * 1024 * 1024;
export const MAX_PACKAGE_ASSET_ARCHIVE_RESOURCE_COUNT_V1 = 512;

const MAX_PACKAGE_ASSET_ARCHIVE_BASE64_BYTES_V1 = Math.ceil(
  MAX_PACKAGE_ASSET_ARCHIVE_RESOURCE_BYTES_V1 / 3,
) * 4;
const PackageAssetResourceIdSchema = z.string().trim().min(1).max(256);
const PackageAssetMimeTypeSchema = z.string().trim().min(1).max(256);

export const PLUGIN_PACKAGE_ASSET_ARCHIVE_KIND_V1 = 'plugin.package-assets.archive' as const;
export const PLUGIN_PACKAGE_ASSET_ARCHIVE_VERSION_V1 = 1 as const;

/**
 * The immutable portable descriptor binds each exact manifest-declared asset
 * before the surrounding generic Artifact envelope receives any bytes.
 */
export const PackageAssetArchiveResourceV1Schema = z.object({
  resourceId: PackageAssetResourceIdSchema,
  path: PluginUiArtifactRelativePathV1Schema,
  mimeType: PackageAssetMimeTypeSchema,
  byteSize: z.number().int().nonnegative().max(MAX_PACKAGE_ASSET_ARCHIVE_RESOURCE_BYTES_V1),
  digestSha256: PluginUiArtifactDigestV1Schema,
}).strict();
export type PackageAssetArchiveResourceV1 = z.infer<typeof PackageAssetArchiveResourceV1Schema>;

function resourceKey(resource: Pick<PackageAssetArchiveResourceV1, 'resourceId' | 'path'>): string {
  return `${resource.resourceId}\u0000${resource.path}`;
}

function isCanonicalResourceOrder(resources: readonly PackageAssetArchiveResourceV1[]): boolean {
  return resources.every((resource, index) => (
    index === 0 || resourceKey(resources[index - 1]!).localeCompare(resourceKey(resource)) < 0
  ));
}

function hasBoundedResourceSet(resources: readonly PackageAssetArchiveResourceV1[]): boolean {
  if (resources.length > MAX_PACKAGE_ASSET_ARCHIVE_RESOURCE_COUNT_V1) return false;
  let totalBytes = 0;
  const resourceIds = new Set<string>();
  for (const resource of resources) {
    if (resourceIds.has(resource.resourceId)) return false;
    resourceIds.add(resource.resourceId);
    totalBytes += resource.byteSize;
    if (totalBytes > MAX_PACKAGE_ASSET_ARCHIVE_TOTAL_BYTES_V1) return false;
  }
  return true;
}

export const PackageAssetArchiveDescriptorV1Schema = z.object({
  archiveDigestSha256: PluginUiArtifactDigestV1Schema,
  resources: z.array(PackageAssetArchiveResourceV1Schema)
    .max(MAX_PACKAGE_ASSET_ARCHIVE_RESOURCE_COUNT_V1),
}).strict().superRefine((value, context) => {
  if (!isCanonicalResourceOrder(value.resources)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resources'],
      message: 'Package Asset archive resources must use canonical resource-id/path ordering.',
    });
  }
  if (!hasBoundedResourceSet(value.resources)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resources'],
      message: 'Package Asset archive resources must be unique and stay within the bounded archive capacity.',
    });
  }
});
export type PackageAssetArchiveDescriptorV1 = z.infer<typeof PackageAssetArchiveDescriptorV1Schema>;

/** Produces the one comparison shape release facts persist and rejoin against. */
export function normalizePackageAssetArchiveDescriptorV1(
  input: unknown,
): PackageAssetArchiveDescriptorV1 {
  const parsed = PackageAssetArchiveDescriptorV1Schema.parse(input);
  return PackageAssetArchiveDescriptorV1Schema.parse({
    archiveDigestSha256: parsed.archiveDigestSha256,
    resources: parsed.resources.map((resource) => ({ ...resource })),
  });
}

export const PackageAssetArchiveHeaderV1Schema = z.object({
  v: z.literal(PLUGIN_PACKAGE_ASSET_ARCHIVE_VERSION_V1),
  kind: z.literal(PLUGIN_PACKAGE_ASSET_ARCHIVE_KIND_V1),
  title: z.null(),
  descriptor: PackageAssetArchiveDescriptorV1Schema,
}).strict();
export type PackageAssetArchiveHeaderV1 = z.infer<typeof PackageAssetArchiveHeaderV1Schema>;

export const PackageAssetArchiveBodyResourceV1Schema = PackageAssetArchiveResourceV1Schema.extend({
  /** Canonical padded base64 for the exact admitted resource bytes. */
  bytesBase64: z.string().max(MAX_PACKAGE_ASSET_ARCHIVE_BASE64_BYTES_V1),
}).strict();
export type PackageAssetArchiveBodyResourceV1 = z.infer<typeof PackageAssetArchiveBodyResourceV1Schema>;

export const PackageAssetArchiveBodyV1Schema = z.object({
  v: z.literal(PLUGIN_PACKAGE_ASSET_ARCHIVE_VERSION_V1),
  resources: z.array(PackageAssetArchiveBodyResourceV1Schema)
    .max(MAX_PACKAGE_ASSET_ARCHIVE_RESOURCE_COUNT_V1),
}).strict().superRefine((value, context) => {
  if (!isCanonicalResourceOrder(value.resources) || !hasBoundedResourceSet(value.resources)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resources'],
      message: 'Package Asset archive body resources must be canonical, unique, and bounded.',
    });
  }
});
export type PackageAssetArchiveBodyV1 = z.infer<typeof PackageAssetArchiveBodyV1Schema>;

export type PackageAssetArchiveOpenedV1 = Readonly<{
  resources: ReadonlyMap<string, Uint8Array>;
}>;

export type PackageAssetArchiveV1 = Readonly<{
  descriptor: PackageAssetArchiveDescriptorV1;
  header: PackageAssetArchiveHeaderV1;
  body: PackageAssetArchiveBodyV1;
}>;

export type DeclaredPackageAssetV1 = Readonly<{
  resourceId: string;
  path: string;
  mimeType: string;
}>;

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function canonicalArchiveBodyText(body: PackageAssetArchiveBodyV1): string {
  return createCanonicalJsonSigningInput(PackageAssetArchiveBodyV1Schema.parse(body));
}

function computePackageAssetArchiveDigestV1(body: PackageAssetArchiveBodyV1): PluginUiArtifactDigestV1 {
  return computePluginUiArtifactSha256DigestV1(
    new TextEncoder().encode(canonicalArchiveBodyText(body)),
  );
}

function descriptorsEqual(
  left: PackageAssetArchiveDescriptorV1,
  right: PackageAssetArchiveDescriptorV1,
): boolean {
  return createCanonicalJsonSigningInput(left) === createCanonicalJsonSigningInput(right);
}

function decodeCanonicalBase64(value: string, expectedByteSize: number): Uint8Array | null {
  if (readCanonicalPaddedBase64DecodedLength(value) !== expectedByteSize) return null;
  try {
    const bytes = decodeBase64(value, 'base64');
    return encodeBase64(bytes, 'base64') === value ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Reads the only resources this archive may carry. Dynamic resources have no
 * package bytes, and non-asset packaged resources stay at their own consumer.
 */
export function readDeclaredPackageAssetsV1(manifest: unknown): readonly DeclaredPackageAssetV1[] | null {
  const parsedManifest = PluginManifestV2Schema.safeParse(manifest);
  if (!parsedManifest.success) return null;

  const declared: DeclaredPackageAssetV1[] = [];
  for (const resource of parsedManifest.data.contributes.resources) {
    // The canonical packaged-resource parser both excludes the dynamic arm
    // (which deliberately has no package path) and gives this byte owner the
    // exact path/content-type contract it is allowed to archive.
    const packaged = PluginPackagedResourceContributionV2Schema.safeParse(resource);
    if (!packaged.success || packaged.data.kind !== 'asset') continue;
    declared.push({
      resourceId: packaged.data.id,
      path: packaged.data.path,
      mimeType: packaged.data.contentType,
    });
  }
  const resources = declared.map((resource) => PackageAssetArchiveResourceV1Schema.safeParse({
    ...resource,
    byteSize: 0,
    digestSha256: `sha256:${'0'.repeat(64)}`,
  }));
  if (resources.some((resource) => !resource.success)) return null;
  if (new Set(declared.map((resource) => resource.resourceId)).size !== declared.length) return null;
  return Object.freeze([...declared]
    .sort((left, right) => resourceKey(left).localeCompare(resourceKey(right)))
    .map((resource) => Object.freeze({ ...resource })));
}

/**
 * Release publication receives a descriptor separately from staged bytes.
 * Keep that boundary tied to the same manifest declaration owner as archive
 * creation, so a valid archive shape cannot introduce an undeclared resource.
 */
export function isPackageAssetArchiveDescriptorDeclaredByManifestV1(input: Readonly<{
  manifest: unknown;
  descriptor: unknown;
}>): boolean {
  const descriptor = PackageAssetArchiveDescriptorV1Schema.safeParse(input.descriptor);
  const declaredAssets = readDeclaredPackageAssetsV1(input.manifest);
  if (!descriptor.success || !declaredAssets) return false;
  return descriptor.data.resources.length === declaredAssets.length
    && descriptor.data.resources.every((resource, index) => {
      const declared = declaredAssets[index]!;
      return resource.resourceId === declared.resourceId
        && resource.path === declared.path
        && resource.mimeType === declared.mimeType;
    });
}

function manifestForArchive(manifest: unknown): ParsedPluginManifestV2 | null {
  const parsed = PluginManifestV2Schema.safeParse(manifest);
  return parsed.success ? parsed.data : null;
}

/**
 * Creates one deterministic logical archive from exact staged package bytes.
 * Extra package files cannot enter the archive because only the manifest's
 * packaged `asset` Resource declarations are selected.
 */
export function createPackageAssetArchiveV1(input: Readonly<{
  manifest: unknown;
  files: readonly Readonly<{
    path: string;
    bytes: Uint8Array;
  }>[];
}>): PackageAssetArchiveV1 | null {
  if (!manifestForArchive(input.manifest)) return null;
  const declaredAssets = readDeclaredPackageAssetsV1(input.manifest);
  if (!declaredAssets) return null;

  const files = new Map<string, Uint8Array>();
  for (const file of input.files) {
    if (!(file.bytes instanceof Uint8Array) || !PluginUiArtifactRelativePathV1Schema.safeParse(file.path).success) {
      return null;
    }
    if (files.has(file.path)) return null;
    files.set(file.path, copyBytes(file.bytes));
  }

  const resources: PackageAssetArchiveResourceV1[] = [];
  const bodyResources: PackageAssetArchiveBodyResourceV1[] = [];
  for (const declared of declaredAssets) {
    const bytes = files.get(declared.path);
    if (!bytes || bytes.byteLength > MAX_PACKAGE_ASSET_ARCHIVE_RESOURCE_BYTES_V1) return null;
    const resource = PackageAssetArchiveResourceV1Schema.parse({
      ...declared,
      byteSize: bytes.byteLength,
      digestSha256: computePluginUiArtifactSha256DigestV1(bytes),
    });
    resources.push(resource);
    bodyResources.push(PackageAssetArchiveBodyResourceV1Schema.parse({
      ...resource,
      bytesBase64: encodeBase64(bytes, 'base64'),
    }));
  }
  if (!hasBoundedResourceSet(resources)) return null;

  const body = PackageAssetArchiveBodyV1Schema.parse({
    v: PLUGIN_PACKAGE_ASSET_ARCHIVE_VERSION_V1,
    resources: bodyResources,
  });
  const descriptor = PackageAssetArchiveDescriptorV1Schema.parse({
    archiveDigestSha256: computePackageAssetArchiveDigestV1(body),
    resources,
  });
  const header = PackageAssetArchiveHeaderV1Schema.parse({
    v: PLUGIN_PACKAGE_ASSET_ARCHIVE_VERSION_V1,
    kind: PLUGIN_PACKAGE_ASSET_ARCHIVE_KIND_V1,
    title: null,
    descriptor,
  });
  return Object.freeze({ descriptor, header, body });
}

/** The generic Artifact body remains its incumbent JSON-string payload. */
export function encodePackageAssetArchiveBodyV1(body: PackageAssetArchiveBodyV1): string {
  return canonicalArchiveBodyText(body);
}

export function decodePackageAssetArchiveBodyV1(value: string): PackageAssetArchiveBodyV1 | null {
  try {
    const parsed = PackageAssetArchiveBodyV1Schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Opens only the exact immutable archive named by the release facts. The
 * header is corroborating data, never a self-authorizing descriptor source.
 */
export function openPackageAssetArchiveV1(input: Readonly<{
  expectedDescriptor: unknown;
  header: unknown;
  body: unknown;
}>): PackageAssetArchiveOpenedV1 | null {
  const expectedDescriptor = PackageAssetArchiveDescriptorV1Schema.safeParse(input.expectedDescriptor);
  const header = PackageAssetArchiveHeaderV1Schema.safeParse(input.header);
  const body = PackageAssetArchiveBodyV1Schema.safeParse(input.body);
  if (!expectedDescriptor.success || !header.success || !body.success) return null;
  if (!descriptorsEqual(header.data.descriptor, expectedDescriptor.data)) return null;

  const resources = new Map<string, Uint8Array>();
  const bodyMetadata = body.data.resources.map((resource) => PackageAssetArchiveResourceV1Schema.parse({
    resourceId: resource.resourceId,
    path: resource.path,
    mimeType: resource.mimeType,
    byteSize: resource.byteSize,
    digestSha256: resource.digestSha256,
  }));
  if (!isCanonicalResourceOrder(bodyMetadata) || !hasBoundedResourceSet(bodyMetadata)) return null;
  if (
    bodyMetadata.length !== expectedDescriptor.data.resources.length
    || bodyMetadata.some((resource, index) => (
      createCanonicalJsonSigningInput(resource)
        !== createCanonicalJsonSigningInput(expectedDescriptor.data.resources[index]!)
    ))
  ) {
    return null;
  }

  for (const resource of body.data.resources) {
    if (resources.has(resource.resourceId)) return null;
    const bytes = decodeCanonicalBase64(resource.bytesBase64, resource.byteSize);
    if (!bytes || computePluginUiArtifactSha256DigestV1(bytes) !== resource.digestSha256) return null;
    resources.set(resource.resourceId, copyBytes(bytes));
  }
  if (computePackageAssetArchiveDigestV1(body.data) !== expectedDescriptor.data.archiveDigestSha256) {
    return null;
  }
  return Object.freeze({ resources });
}
