import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createPluginCompatibilityProjectionV1,
  createPackageAssetArchiveV1,
  readDeclaredPackageAssetsV1,
  type PluginCompatibilityProjectionV1,
} from '@happier-dev/protocol';
import type { PackageAssetArchiveV1 } from '@happier-dev/protocol/plugins/availability';
import {
  PluginUiArtifactDigestV1Schema,
  PluginUiArtifactsManifestV1Schema,
  type PluginUiArtifactsManifestEntryV1,
  type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';

import { readPluginManifest } from '@/plugins/manifest/read';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

import {
  cleanupExtractedPortableArchive,
  extractPortableTarGzipArchive,
} from './extract';
import {
  PortableArchiveError,
  type PortableArchiveFile,
  type PortableArchiveLimits,
} from './types';
import { normalizeNpmPackageName } from '../npm/normalize';
import { readPortableNpmPackageFiles } from '../npm/packageFiles';

const PACKAGE_MANIFEST_PATH = '.happier-plugin/plugin.json';
const UI_ARTIFACTS_ROOT = 'dist/happier-plugin-ui';
const UI_ARTIFACTS_MANIFEST_PATH = `${UI_ARTIFACTS_ROOT}/ui-artifacts.json`;
const MAX_METADATA_BYTES = 1024 * 1024;
type OwnedStagedCandidateState = {
  extracted: Awaited<ReturnType<typeof extractPortableTarGzipArchive>>;
  cleanupPromise: Promise<void> | null;
};
const ownedStagedCandidates = new WeakMap<StagedNpmCompatiblePluginArchive, OwnedStagedCandidateState>();

export type PluginArchiveStagingRejectionCode =
  | 'staging_aborted'
  | 'archive_rejected'
  | 'package_json_missing'
  | 'package_json_invalid'
  | 'package_identity_mismatch'
  | 'package_contract_invalid'
  | 'manifest_invalid'
  | 'manifest_identity_mismatch'
  | 'package_asset_invalid'
  | 'published_entrypoint_invalid'
  | 'declared_file_missing'
  | 'ui_artifact_manifest_missing'
  | 'ui_artifact_manifest_invalid'
  | 'ui_artifact_identity_mismatch'
  | 'ui_artifact_file_missing'
  | 'ui_artifact_digest_mismatch';

export type PluginArchiveStagingRejection = Readonly<{
  code: PluginArchiveStagingRejectionCode;
  message: string;
  archiveCode?: string;
}>;

export type StagedNpmCompatiblePluginArchive = Readonly<{
  rootPath: string;
  inventory: readonly PortableArchiveFile[];
  /** Exact verified archive bytes, supplied by the acquisition boundary. */
  archiveDigestSha256: `sha256:${string}`;
  package: Readonly<{ name: string; version: string }>;
  manifest: Readonly<{
    id: string;
    version: string;
    digest: string;
    value: CanonicalPluginManifest;
  }>;
  generatedUiArtifacts: Readonly<{
    contributionIds: readonly string[];
    /** The exact generated graph validated from this candidate archive. */
    manifest: PluginUiArtifactsManifestV1;
    manifestDigest?: `sha256:${string}`;
  }>;
  /** Exact logical browser-safe archive reconstructed only from admitted package asset Resources. */
  packageAssetArchive: PackageAssetArchiveV1;
  /** Derived only after the extracted manifest and UI inventory are verified. */
  compatibilityProjection: PluginCompatibilityProjectionV1;
}>;

export type StageNpmCompatiblePluginArchiveResult =
  | Readonly<{ ok: true; candidate: StagedNpmCompatiblePluginArchive }>
  | Readonly<{ ok: false; rejection: PluginArchiveStagingRejection }>;

export type StageNpmCompatiblePluginArchiveParams = Readonly<{
  archivePath: string;
  byteLength: number;
  integrity: string;
  archiveDigestSha256: `sha256:${string}`;
  expectedPackage?: Readonly<{ name: string; version: string }>;
  /** Host-owned first-party packing may validate the reserved `happier.*` namespace. */
  manifestAuthority?: 'external' | 'bundled_first_party';
  stagingParentPath: string;
  archiveLimits?: Partial<PortableArchiveLimits>;
  signal?: AbortSignal;
}>;

class CandidateRejected extends Error {
  readonly rejection: PluginArchiveStagingRejection;

  constructor(code: PluginArchiveStagingRejectionCode, message: string) {
    super(message);
    this.name = 'CandidateRejected';
    this.rejection = Object.freeze({ code, message });
  }
}

function reject(code: PluginArchiveStagingRejectionCode, message: string): never {
  throw new CandidateRejected(code, message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeUntrustedPath(path: string): string {
  const characters = Array.from(path);
  const prefix = characters.slice(0, 64).join('');
  return `${JSON.stringify(prefix)}${characters.length > 64 ? '…' : ''}`;
}

function findInventoryFile(
  inventoryByPath: ReadonlyMap<string, PortableArchiveFile>,
  path: string,
  missingCode: PluginArchiveStagingRejectionCode,
): PortableArchiveFile {
  const file = inventoryByPath.get(path);
  if (!file) reject(missingCode, `Candidate is missing required file: ${describeUntrustedPath(path)}`);
  return file;
}

async function readBoundedJson(input: Readonly<{
  rootPath: string;
  path: string;
  inventoryByPath: ReadonlyMap<string, PortableArchiveFile>;
  missingCode: PluginArchiveStagingRejectionCode;
  invalidCode: PluginArchiveStagingRejectionCode;
  signal?: AbortSignal;
}>): Promise<Readonly<{ value: unknown; file: PortableArchiveFile }>> {
  assertStagingNotAborted(input.signal);
  const file = findInventoryFile(input.inventoryByPath, input.path, input.missingCode);
  if (file.byteLength > MAX_METADATA_BYTES) reject(input.invalidCode, `${input.path} exceeds the metadata byte limit`);
  try {
    const raw = await readFile(join(input.rootPath, ...input.path.split('/')), {
      encoding: 'utf8',
      signal: input.signal,
    });
    assertStagingNotAborted(input.signal);
    return { value: JSON.parse(raw), file };
  } catch {
    assertStagingNotAborted(input.signal);
    return reject(input.invalidCode, `${input.path} is not valid JSON`);
  }
}

function assertStagingNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) reject('staging_aborted', 'Candidate staging was aborted');
}

function readPackageContract(
  value: unknown,
  expectedPackage: StageNpmCompatiblePluginArchiveParams['expectedPackage'],
  manifestAuthority: StageNpmCompatiblePluginArchiveParams['manifestAuthority'],
): Readonly<{ name: string; version: string; files: readonly string[] }> {
  if (!isRecord(value)) reject('package_json_invalid', 'package.json must contain an object');
  if (typeof value.name !== 'string' || typeof value.version !== 'string') {
    reject('package_json_invalid', 'package.json must declare string name and version values');
  }
  try {
    if (normalizeNpmPackageName(value.name) !== value.name) throw new Error('non-canonical package name');
  } catch {
    reject('package_json_invalid', 'package.json must declare a canonical npm package name');
  }
  if (!value.version || value.version !== value.version.trim()) {
    reject('package_json_invalid', 'package.json must declare a canonical package version');
  }
  if (expectedPackage && (value.name !== expectedPackage.name || value.version !== expectedPackage.version)) {
    reject('package_identity_mismatch', 'package.json name/version do not match the exact resolved npm artifact');
  }
  if (manifestAuthority === 'bundled_first_party') {
    // This authority is only granted by the canonical workspace pack owner.
    // First-party bundled sources deliberately remain private and omit the
    // external-plugin discovery metadata from their package contract.
    if (value.private !== true || value.keywords !== undefined || value.happier !== undefined) {
      reject('package_contract_invalid', 'Bundled first-party package.json must remain private and omit external plugin metadata');
    }
  } else {
    const keywords = value.keywords;
    if (!Array.isArray(keywords) || !keywords.every((item) => typeof item === 'string') || !keywords.includes('happier-plugin')) {
      reject('package_contract_invalid', 'package.json must declare the happier-plugin keyword');
    }
    const happier = value.happier;
    if (!isRecord(happier) || happier.manifest !== PACKAGE_MANIFEST_PATH) {
      reject('package_contract_invalid', `package.json happier.manifest must be exactly ${PACKAGE_MANIFEST_PATH}`);
    }
  }
  let files: readonly string[];
  try {
    files = readPortableNpmPackageFiles(value.files);
  } catch (cause) {
    reject(
      'package_contract_invalid',
      cause instanceof Error ? cause.message : 'package.json files is not a valid selected-file inventory',
    );
  }
  return { name: value.name, version: value.version, files };
}

function validatePortablePackageInventory(
  inventory: readonly PortableArchiveFile[],
  selectedPaths: readonly string[],
  manifestAuthority: StageNpmCompatiblePluginArchiveParams['manifestAuthority'],
): void {
  if (inventory.some((file) => file.path === 'node_modules' || file.path.startsWith('node_modules/'))) {
    reject('package_contract_invalid', 'Portable plugin artifacts must not contain a node_modules dependency tree');
  }
  const isSelected = (path: string, selectedPath: string): boolean => (
    path === selectedPath || path.startsWith(`${selectedPath}/`)
  );
  const unselected = inventory.find((file) => (
    file.path !== 'package.json'
    && !(manifestAuthority === 'bundled_first_party' && file.path === PACKAGE_MANIFEST_PATH)
    && !selectedPaths.some((selectedPath) => isSelected(file.path, selectedPath))
  ));
  if (unselected) {
    reject(
      'package_contract_invalid',
      `Portable plugin artifact contains a file absent from package.json files: ${describeUntrustedPath(unselected.path)}`,
    );
  }
  const staleSelection = selectedPaths.find((selectedPath) => (
    !inventory.some((file) => isSelected(file.path, selectedPath))
  ));
  if (staleSelection) {
    reject(
      'package_contract_invalid',
      `package.json files selects a path absent from the portable artifact: ${describeUntrustedPath(staleSelection)}`,
    );
  }
}

function readDeclaredFilePath(value: string, label: string): string {
  if (!value.startsWith('./') || value.includes('\\') || value.includes('\u0000')) {
    return reject('published_entrypoint_invalid', `${label} must be a portable plugin-relative path`);
  }
  const path = value.slice(2);
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return reject('published_entrypoint_invalid', `${label} must not traverse or contain empty segments`);
  }
  return path;
}

function validatePublishedEntrypoints(
  manifest: CanonicalPluginManifest,
  inventoryByPath: ReadonlyMap<string, PortableArchiveFile>,
): void {
  if (manifest.entrypoints?.development && !manifest.entrypoints.daemon) {
    reject('published_entrypoint_invalid', 'Published npm plugins may not rely on a development-only entrypoint');
  }
  if (manifest.entrypoints?.daemon) {
    const daemonPath = readDeclaredFilePath(manifest.entrypoints.daemon, 'entrypoints.daemon');
    findInventoryFile(inventoryByPath, daemonPath, 'declared_file_missing');
  }
}

type ExpectedUiArtifact = Readonly<{
  tier: 'hostedWeb' | 'reactNative';
  voicePlatforms?: ReadonlySet<'web' | 'ios' | 'android'>;
  expectedRepackModule?: Readonly<{
    modulePath: string;
    exportName: string;
  }>;
}>;

function expectedUiArtifacts(manifest: CanonicalPluginManifest): ReadonlyMap<string, ExpectedUiArtifact> {
  const expected = new Map<string, ExpectedUiArtifact>();
  const claim = (artifact: Readonly<{
    id: string;
    tier: 'hostedWeb' | 'reactNative';
    voicePlatforms?: readonly ('web' | 'ios' | 'android')[];
    expectedRepackModule?: Readonly<{
      modulePath: string;
      exportName: string;
    }>;
  }>): void => {
    const current = expected.get(artifact.id);
    if (current && current.tier !== artifact.tier) {
      reject('manifest_invalid', `UI artifact ${artifact.id} is assigned conflicting renderer tiers`);
    }
    const voicePlatforms = artifact.voicePlatforms || current?.voicePlatforms
      ? new Set([...(current?.voicePlatforms ?? []), ...(artifact.voicePlatforms ?? [])])
      : undefined;
    if (
      current?.expectedRepackModule
      && artifact.expectedRepackModule
      && (
        current.expectedRepackModule.modulePath !== artifact.expectedRepackModule.modulePath
        || current.expectedRepackModule.exportName !== artifact.expectedRepackModule.exportName
      )
    ) {
      reject('manifest_invalid', `UI artifact ${artifact.id} is assigned conflicting Re.Pack modules`);
    }
    const expectedRepackModule = current?.expectedRepackModule ?? artifact.expectedRepackModule;
    expected.set(artifact.id, Object.freeze({
      tier: artifact.tier,
      ...(voicePlatforms ? { voicePlatforms } : {}),
      ...(expectedRepackModule ? { expectedRepackModule } : {}),
    }));
  };
  for (const renderer of manifest.contributes.ui.renderers) {
    const artifact = renderer.kind === 'reactNative'
      ? { id: renderer.artifact, tier: 'reactNative' as const }
      : renderer.kind === 'hostedWeb' && renderer.source.kind === 'artifact'
        ? { id: renderer.source.artifact, tier: 'hostedWeb' as const }
        : undefined;
    if (!artifact) continue;
    claim(artifact);
  }
  for (const provider of manifest.contributes.voiceProviders) {
    if (provider.kind !== 'conversation') continue;
    claim({
      id: provider.client.artifactId,
      tier: 'reactNative',
      voicePlatforms: provider.platforms,
      expectedRepackModule: Object.freeze({
        modulePath: provider.client.modulePath,
        exportName: provider.client.exportName,
      }),
    });
  }
  return expected;
}

function readUiFilePath(value: string): string {
  const path = value.trim();
  if (!path || path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\\')) {
    reject('ui_artifact_manifest_invalid', `UI artifact path is not portable: ${describeUntrustedPath(value)}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    reject('ui_artifact_manifest_invalid', `UI artifact path is not relative: ${describeUntrustedPath(value)}`);
  }
  return path;
}

async function computeUiFileSetDigest(input: Readonly<{
  rootPath: string;
  files: readonly Readonly<{ relativePath: string; inventory: PortableArchiveFile }>[];
  signal?: AbortSignal;
}>): Promise<`sha256:${string}`> {
  assertStagingNotAborted(input.signal);
  const hash = createHash('sha256').update('happier.pluginUi.fileSet.v1\n');
  for (const file of [...input.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const pathBytes = Buffer.from(file.relativePath, 'utf8');
    hash.update(`path:${pathBytes.byteLength}\n`);
    hash.update(pathBytes);
    hash.update(`\nbytes:${file.inventory.byteLength}\n`);
    await new Promise<void>((resolve, rejectPromise) => {
      const stream = createReadStream(join(input.rootPath, UI_ARTIFACTS_ROOT, ...file.relativePath.split('/')), {
        signal: input.signal,
      });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('end', resolve);
      stream.once('error', rejectPromise);
    });
    hash.update('\n');
    assertStagingNotAborted(input.signal);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function validateUiArtifacts(input: Readonly<{
  rootPath: string;
  manifest: CanonicalPluginManifest;
  inventoryByPath: ReadonlyMap<string, PortableArchiveFile>;
  signal?: AbortSignal;
}>): Promise<StagedNpmCompatiblePluginArchive['generatedUiArtifacts']> {
  assertStagingNotAborted(input.signal);
  const expected = expectedUiArtifacts(input.manifest);
  const expectedIds = [...expected.keys()].sort((left, right) => left.localeCompare(right));
  const manifestFile = input.inventoryByPath.get(UI_ARTIFACTS_MANIFEST_PATH);
  const packagedFiles = [...input.inventoryByPath.keys()]
    .filter((path) => path.startsWith(`${UI_ARTIFACTS_ROOT}/`) && path !== UI_ARTIFACTS_MANIFEST_PATH)
    .map((path) => path.slice(UI_ARTIFACTS_ROOT.length + 1))
    .sort((left, right) => left.localeCompare(right));
  if (expectedIds.length === 0) {
    if (manifestFile || packagedFiles.length > 0) {
      reject('ui_artifact_identity_mismatch', 'Candidate contains generated UI artifacts that no renderer declares');
    }
    return Object.freeze({
      contributionIds: Object.freeze([]),
      manifest: PluginUiArtifactsManifestV1Schema.parse({ version: 1, entries: [] }),
    });
  }
  if (!manifestFile) reject('ui_artifact_manifest_missing', 'Candidate is missing generated UI artifact inventory');
  const parsedJson = await readBoundedJson({
    rootPath: input.rootPath,
    path: UI_ARTIFACTS_MANIFEST_PATH,
    inventoryByPath: input.inventoryByPath,
    missingCode: 'ui_artifact_manifest_missing',
    invalidCode: 'ui_artifact_manifest_invalid',
    signal: input.signal,
  });
  const parsed = PluginUiArtifactsManifestV1Schema.safeParse(parsedJson.value);
  if (!parsed.success) reject('ui_artifact_manifest_invalid', 'Generated UI artifact inventory does not match its schema');

  const actualIds = [...new Set(parsed.data.entries.map((entry) => entry.contributionId))]
    .sort((left, right) => left.localeCompare(right));
  if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
    reject('ui_artifact_identity_mismatch', 'Generated UI artifacts do not exactly match manifest artifact references');
  }

  for (const [artifactId, expectation] of expected) {
    if (!expectation.voicePlatforms) continue;
    const actualPlatforms = new Set(parsed.data.entries
      .filter((entry) => entry.contributionId === artifactId && entry.tier === 'reactNative')
      .flatMap((entry) => entry.platform ? [entry.platform] : []));
    if (
      actualPlatforms.size !== expectation.voicePlatforms.size
      || [...expectation.voicePlatforms].some((platform) => !actualPlatforms.has(platform))
    ) {
      reject(
        'ui_artifact_identity_mismatch',
        `Generated Voice UI artifact platforms do not exactly match the declaration: ${artifactId}`,
      );
    }
  }

  const claimedFiles = new Set<string>();
  const artifactSlots = new Set<string>();
  for (const entry of parsed.data.entries) {
    const expectation = expected.get(entry.contributionId);
    if (expectation?.tier !== entry.tier) {
      reject('ui_artifact_identity_mismatch', `Generated UI artifact tier does not match renderer: ${entry.contributionId}`);
    }
    if (
      entry.repack
      && expectation.expectedRepackModule
      && (
        entry.repack.modulePath !== expectation.expectedRepackModule.modulePath
        || entry.repack.exportName !== expectation.expectedRepackModule.exportName
      )
    ) {
      reject(
        'ui_artifact_identity_mismatch',
        `Generated Voice UI artifact Re.Pack identity does not match the declaration: ${entry.contributionId}`,
      );
    }
    if (
      entry.tier === 'hostedWeb'
      && entry.platform !== undefined
      && entry.platform !== 'web'
    ) {
      reject('ui_artifact_identity_mismatch', `Generated UI artifact platform is invalid for its tier: ${entry.contributionId}`);
    }
    const slot = `${entry.contributionId}\u0000${entry.tier}\u0000${entry.platform ?? ''}`;
    if (artifactSlots.has(slot)) {
      reject('ui_artifact_identity_mismatch', `Generated UI artifact slot is declared more than once: ${entry.contributionId}`);
    }
    artifactSlots.add(slot);
    await validateUiArtifactEntry({
      rootPath: input.rootPath,
      entry,
      inventoryByPath: input.inventoryByPath,
      claimedFiles,
      signal: input.signal,
    });
  }
  const claimed = [...claimedFiles].sort((left, right) => left.localeCompare(right));
  if (packagedFiles.length !== claimed.length || packagedFiles.some((path, index) => path !== claimed[index])) {
    reject('ui_artifact_identity_mismatch', 'Generated UI artifact inventory does not claim exactly the packaged artifact files');
  }
  return Object.freeze({
    contributionIds: Object.freeze(actualIds),
    manifest: parsed.data,
    manifestDigest: parsedJson.file.digest,
  });
}

async function createStagedPackageAssetArchive(input: Readonly<{
  rootPath: string;
  manifest: CanonicalPluginManifest;
  inventoryByPath: ReadonlyMap<string, PortableArchiveFile>;
  signal?: AbortSignal;
}>): Promise<PackageAssetArchiveV1> {
  assertStagingNotAborted(input.signal);
  const declaredAssets = readDeclaredPackageAssetsV1(input.manifest);
  if (!declaredAssets) {
    return reject('package_asset_invalid', 'Manifest package asset declarations are not archive-safe');
  }
  const files: Array<Readonly<{ path: string; bytes: Uint8Array }>> = [];
  for (const asset of declaredAssets) {
    const inventory = findInventoryFile(input.inventoryByPath, asset.path, 'declared_file_missing');
    const bytes = await readFile(join(input.rootPath, ...asset.path.split('/')), { signal: input.signal });
    assertStagingNotAborted(input.signal);
    if (bytes.byteLength !== inventory.byteLength) {
      return reject('package_asset_invalid', `Package asset bytes changed during staging: ${describeUntrustedPath(asset.path)}`);
    }
    files.push({ path: asset.path, bytes });
  }
  const archive = createPackageAssetArchiveV1({ manifest: input.manifest, files });
  if (!archive) return reject('package_asset_invalid', 'Package asset bytes do not match the declared archive contract');
  return archive;
}

async function validateUiArtifactEntry(input: Readonly<{
  rootPath: string;
  entry: PluginUiArtifactsManifestEntryV1;
  inventoryByPath: ReadonlyMap<string, PortableArchiveFile>;
  claimedFiles: Set<string>;
  signal?: AbortSignal;
}>): Promise<void> {
  assertStagingNotAborted(input.signal);
  const entryPath = readUiFilePath(input.entry.entry);
  const declaredPaths = input.entry.files.map((file) => readUiFilePath(file.relativePath));
  if (!declaredPaths.includes(entryPath) || new Set(declaredPaths).size !== declaredPaths.length) {
    reject('ui_artifact_manifest_invalid', `UI artifact ${input.entry.contributionId} has an invalid file set`);
  }
  const files = input.entry.files.map((declaredFile) => {
    const relativePath = readUiFilePath(declaredFile.relativePath);
    if (input.claimedFiles.has(relativePath)) {
      reject('ui_artifact_identity_mismatch', `UI artifact file is claimed more than once: ${relativePath}`);
    }
    input.claimedFiles.add(relativePath);
    const inventoryPath = `${UI_ARTIFACTS_ROOT}/${relativePath}`;
    const inventory = findInventoryFile(input.inventoryByPath, inventoryPath, 'ui_artifact_file_missing');
    if (inventory.byteLength !== declaredFile.byteSize || inventory.digest !== declaredFile.digest) {
      reject('ui_artifact_digest_mismatch', `UI artifact file integrity mismatch: ${relativePath}`);
    }
    return {
      relativePath,
      inventory,
    };
  });
  const actualDigest = await computeUiFileSetDigest({ rootPath: input.rootPath, files, signal: input.signal });
  if (actualDigest !== input.entry.digest) {
    reject('ui_artifact_digest_mismatch', `UI artifact digest mismatch for ${input.entry.contributionId}`);
  }
}

function rejectionFromCause(cause: unknown, signal: AbortSignal | undefined): PluginArchiveStagingRejection {
  if (signal?.aborted) return Object.freeze({ code: 'staging_aborted', message: 'Candidate staging was aborted' });
  if (cause instanceof CandidateRejected) return cause.rejection;
  if (cause instanceof PortableArchiveError) {
    if (cause.code === 'archive_aborted') return Object.freeze({ code: 'staging_aborted', message: cause.message, archiveCode: cause.code });
    return Object.freeze({ code: 'archive_rejected', message: cause.message, archiveCode: cause.code });
  }
  return Object.freeze({ code: 'archive_rejected', message: 'Candidate staging failed before validation completed' });
}

export async function stageNpmCompatiblePluginArchive(
  params: StageNpmCompatiblePluginArchiveParams,
): Promise<StageNpmCompatiblePluginArchiveResult> {
  let extracted: Awaited<ReturnType<typeof extractPortableTarGzipArchive>> | undefined;
  try {
    const archiveDigestSha256 = PluginUiArtifactDigestV1Schema.parse(params.archiveDigestSha256);
    extracted = await extractPortableTarGzipArchive({
      archivePath: params.archivePath,
      expectedArchiveBytes: params.byteLength,
      expectedIntegrity: params.integrity,
      stagingParentPath: params.stagingParentPath,
      stripRootDirectory: 'package',
      limits: params.archiveLimits,
      signal: params.signal,
    });
    assertStagingNotAborted(params.signal);
    const inventoryByPath = new Map(extracted.inventory.map((file) => [file.path, file] as const));
    const packageJson = await readBoundedJson({
      rootPath: extracted.rootPath,
      path: 'package.json',
      inventoryByPath,
      missingCode: 'package_json_missing',
      invalidCode: 'package_json_invalid',
      signal: params.signal,
    });
    const packageContract = readPackageContract(packageJson.value, params.expectedPackage, params.manifestAuthority);
    validatePortablePackageInventory(extracted.inventory, packageContract.files, params.manifestAuthority);
    const packageIdentity = Object.freeze({
      name: packageContract.name,
      version: packageContract.version,
    });
    // The manifest carries no byte ceiling of its own. Strict UTF-8 decoding,
    // JSON parsing, schema/semantic validation, and the depth-bounded traversal
    // guard belong to manifest ingestion below; per-file and aggregate
    // expansion bounds belong to the archive limits already applied above.
    // First-party manifests are legitimately large (Channels publishes ~1.5 MiB
    // of declarative `contributes` and localized strings), so a generic
    // metadata cap here only rejected valid products.
    const manifestFile = findInventoryFile(inventoryByPath, PACKAGE_MANIFEST_PATH, 'manifest_invalid');
    const manifestResult = await readPluginManifest({
      manifestPath: join(extracted.rootPath, PACKAGE_MANIFEST_PATH),
      ...(params.manifestAuthority ? { manifestAuthority: params.manifestAuthority } : {}),
    });
    assertStagingNotAborted(params.signal);
    if (!manifestResult.ok) reject('manifest_invalid', 'Plugin manifest failed strict ingestion and semantic validation');
    if (manifestResult.manifest.version !== packageIdentity.version) {
      reject('manifest_identity_mismatch', 'Plugin manifest version does not match package.json version');
    }
    validatePublishedEntrypoints(manifestResult.manifest, inventoryByPath);
    const generatedUiArtifacts = await validateUiArtifacts({
      rootPath: extracted.rootPath,
      manifest: manifestResult.manifest,
      inventoryByPath,
      signal: params.signal,
    });
    const packageAssetArchive = await createStagedPackageAssetArchive({
      rootPath: extracted.rootPath,
      manifest: manifestResult.manifest,
      inventoryByPath,
      signal: params.signal,
    });
    const compatibilityProjection = createPluginCompatibilityProjectionV1({
      manifest: manifestResult.manifest,
      uiArtifacts: generatedUiArtifacts.manifest,
    });
    const staged: StagedNpmCompatiblePluginArchive = Object.freeze({
      rootPath: extracted.rootPath,
      inventory: extracted.inventory,
      archiveDigestSha256,
      package: Object.freeze(packageIdentity),
      manifest: Object.freeze({
        id: manifestResult.manifest.id,
        version: manifestResult.manifest.version,
        digest: manifestFile.digest,
        value: manifestResult.manifest,
      }),
      generatedUiArtifacts,
      packageAssetArchive,
      compatibilityProjection,
    });
    ownedStagedCandidates.set(staged, { extracted, cleanupPromise: null });
    return Object.freeze({ ok: true, candidate: staged });
  } catch (cause) {
    if (extracted) await cleanupExtractedPortableArchive(extracted);
    return Object.freeze({ ok: false, rejection: rejectionFromCause(cause, params.signal) });
  }
}

export function cleanupStagedNpmCompatiblePluginArchive(candidate: StagedNpmCompatiblePluginArchive): Promise<void> {
  const state = ownedStagedCandidates.get(candidate);
  if (!state) return Promise.reject(new Error('Refusing to clean a path without an operation-owned staged candidate handle'));
  if (state.cleanupPromise) return state.cleanupPromise;
  const cleanupPromise = cleanupExtractedPortableArchive(state.extracted)
    .then(() => { ownedStagedCandidates.delete(candidate); })
    .catch((cause: unknown) => {
      state.cleanupPromise = null;
      throw cause;
    });
  state.cleanupPromise = cleanupPromise;
  return cleanupPromise;
}
