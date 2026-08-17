import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import {
  PluginUiArtifactFileV1Schema,
  PluginUiArtifactRelativePathV1Schema,
  type PluginUiArtifactFileV1,
} from '../contributions/ui/artifacts.js';
import {
  PluginUiArtifactsManifestEntryV1Schema,
  type PluginUiArtifactsManifestEntryV1,
} from './uiArtifactsManifest.js';
import {
  PluginUiArtifactDigestV1Schema,
  verifyPluginUiArtifactBytesIntegrityV1,
  verifyPluginUiArtifactFileSetIntegrityV1,
  type PluginUiArtifactDigestV1,
} from './artifactIntegrity.js';

/** The immutable logical payload carried by one classified generic Artifact. */
export const PLUGIN_UI_ARTIFACT_ARCHIVE_KIND_V1 = 'plugin.ui.archive' as const;
export const PLUGIN_UI_ARTIFACT_ARCHIVE_VERSION_V1 = 1 as const;

/**
 * This is the logical generic-Artifact header, not a new persistence envelope.
 * The surrounding Account Artifact owner still supplies plain/E2EE storage.
 */
export const PluginUiArtifactArchiveHeaderV1Schema = z.object({
  v: z.literal(PLUGIN_UI_ARTIFACT_ARCHIVE_VERSION_V1),
  kind: z.literal(PLUGIN_UI_ARTIFACT_ARCHIVE_KIND_V1),
  title: z.null(),
  artifactGraph: PluginUiArtifactsManifestEntryV1Schema,
}).strict();
export type PluginUiArtifactArchiveHeaderV1 =
  z.infer<typeof PluginUiArtifactArchiveHeaderV1Schema>;

export const PluginUiArtifactArchiveFileV1Schema = z.object({
  relativePath: PluginUiArtifactRelativePathV1Schema,
  /** Canonical base64 bytes inside the one generic Artifact body. */
  bytesBase64: z.string().min(1),
}).strict();
export type PluginUiArtifactArchiveFileV1 =
  z.infer<typeof PluginUiArtifactArchiveFileV1Schema>;

export const PluginUiArtifactArchiveBodyV1Schema = z.object({
  v: z.literal(PLUGIN_UI_ARTIFACT_ARCHIVE_VERSION_V1),
  files: z.array(PluginUiArtifactArchiveFileV1Schema).min(1),
}).strict();
export type PluginUiArtifactArchiveBodyV1 =
  z.infer<typeof PluginUiArtifactArchiveBodyV1Schema>;

export type PluginUiArtifactArchiveOpenedV1 = Readonly<{
  artifactGraph: PluginUiArtifactsManifestEntryV1;
  files: ReadonlyMap<string, Uint8Array>;
}>;

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function artifactKindFor(tier: PluginUiArtifactsManifestEntryV1['tier']): string {
  return tier === 'reactNative' ? 'reactNativeBundle' : 'hostedWebAsset';
}

function decodeCanonicalBase64(value: string): Uint8Array | null {
  try {
    const bytes = decodeBase64(value, 'base64');
    return encodeBase64(bytes, 'base64') === value ? bytes : null;
  } catch {
    return null;
  }
}

function hasExpectedFileSet(
  declaredFiles: readonly PluginUiArtifactFileV1[],
  files: ReadonlyMap<string, Uint8Array>,
): boolean {
  return files.size === declaredFiles.length
    && declaredFiles.every((declared) => files.has(declared.relativePath));
}

function verifyFiles(input: Readonly<{
  pluginId: string;
  expectedArtifactDigest: PluginUiArtifactDigestV1;
  artifactGraph: PluginUiArtifactsManifestEntryV1;
  files: ReadonlyMap<string, Uint8Array>;
}>): boolean {
  if (!hasExpectedFileSet(input.artifactGraph.files, input.files)) return false;
  const artifactKind = artifactKindFor(input.artifactGraph.tier);
  for (const declared of input.artifactGraph.files) {
    const bytes = input.files.get(declared.relativePath);
    if (!bytes || bytes.byteLength !== declared.byteSize) return false;
    const integrity = verifyPluginUiArtifactBytesIntegrityV1({
      bytes,
      integrity: {
        digest: declared.digest,
        pluginId: input.pluginId,
        contributionId: input.artifactGraph.contributionId,
        artifactKind,
      },
    });
    if (!integrity.ok) return false;
  }
  return verifyPluginUiArtifactFileSetIntegrityV1({
    files: input.artifactGraph.files.map((declared) => ({
      relativePath: declared.relativePath,
      bytes: input.files.get(declared.relativePath)!,
    })),
    integrity: {
      digest: input.expectedArtifactDigest,
      pluginId: input.pluginId,
      contributionId: input.artifactGraph.contributionId,
      artifactKind,
    },
  }).ok;
}

/**
 * Builds the strict logical archive before it is handed to the generic
 * Artifact plain/E2EE envelope owner. It never allocates a file row, object
 * store, upload session, or a second digest authority.
 */
export function createPluginUiArtifactArchiveV1(input: Readonly<{
  pluginId: string;
  artifactGraph: unknown;
  files: readonly Readonly<{
    relativePath: string;
    bytes: Uint8Array;
  }>[];
}>): Readonly<{
  header: PluginUiArtifactArchiveHeaderV1;
  body: PluginUiArtifactArchiveBodyV1;
}> | null {
  const graph = PluginUiArtifactsManifestEntryV1Schema.safeParse(input.artifactGraph);
  if (!graph.success) return null;
  const pluginId = String(input.pluginId ?? '').trim();
  if (!pluginId) return null;

  const files = new Map<string, Uint8Array>();
  for (const file of input.files) {
    if (
      !PluginUiArtifactRelativePathV1Schema.safeParse(file.relativePath).success
      || !(file.bytes instanceof Uint8Array)
      || files.has(file.relativePath)
    ) {
      return null;
    }
    files.set(file.relativePath, copyBytes(file.bytes));
  }
  if (!verifyFiles({
    pluginId,
    expectedArtifactDigest: graph.data.digest,
    artifactGraph: graph.data,
    files,
  })) {
    return null;
  }

  const header = PluginUiArtifactArchiveHeaderV1Schema.parse({
    v: PLUGIN_UI_ARTIFACT_ARCHIVE_VERSION_V1,
    kind: PLUGIN_UI_ARTIFACT_ARCHIVE_KIND_V1,
    title: null,
    artifactGraph: graph.data,
  });
  const body = PluginUiArtifactArchiveBodyV1Schema.parse({
    v: PLUGIN_UI_ARTIFACT_ARCHIVE_VERSION_V1,
    files: graph.data.files.map((declared) => ({
      relativePath: declared.relativePath,
      bytesBase64: encodeBase64(files.get(declared.relativePath)!, 'base64'),
    })),
  });
  return Object.freeze({ header, body });
}

/** The generic Artifact body remains its incumbent JSON string payload. */
export function encodePluginUiArtifactArchiveBodyV1(
  body: PluginUiArtifactArchiveBodyV1,
): string {
  return JSON.stringify(PluginUiArtifactArchiveBodyV1Schema.parse(body));
}

export function decodePluginUiArtifactArchiveBodyV1(
  value: string,
): PluginUiArtifactArchiveBodyV1 | null {
  try {
    const parsed = PluginUiArtifactArchiveBodyV1Schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Opens only a full, exact archive. The caller must still keep Account scope
 * current; this codec owns neither transport nor byte-source selection.
 */
export function openPluginUiArtifactArchiveV1(input: Readonly<{
  pluginId: string;
  expectedArtifactDigest: string;
  header: unknown;
  body: unknown;
}>): PluginUiArtifactArchiveOpenedV1 | null {
  const header = PluginUiArtifactArchiveHeaderV1Schema.safeParse(input.header);
  const body = PluginUiArtifactArchiveBodyV1Schema.safeParse(input.body);
  const expectedArtifactDigest = PluginUiArtifactDigestV1Schema.safeParse(
    input.expectedArtifactDigest,
  );
  const pluginId = String(input.pluginId ?? '').trim();
  if (!header.success || !body.success || !expectedArtifactDigest.success || !pluginId) {
    return null;
  }
  if (header.data.artifactGraph.digest !== expectedArtifactDigest.data) return null;

  const files = new Map<string, Uint8Array>();
  for (const file of body.data.files) {
    if (files.has(file.relativePath)) return null;
    const bytes = decodeCanonicalBase64(file.bytesBase64);
    if (!bytes) return null;
    files.set(file.relativePath, copyBytes(bytes));
  }
  if (!verifyFiles({
    pluginId,
    expectedArtifactDigest: expectedArtifactDigest.data,
    artifactGraph: header.data.artifactGraph,
    files,
  })) {
    return null;
  }
  return Object.freeze({
    artifactGraph: header.data.artifactGraph,
    files,
  });
}
