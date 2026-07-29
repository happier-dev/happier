import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as tar from 'tar';

import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

import { normalizeNpmPackageName } from '../distribution/npm/normalize';
import { readPortableNpmPackageFiles } from '../distribution/npm/packageFiles';
import {
  cleanupStagedNpmArtifactCandidate,
  stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { archiveSha256IntegrityFromDigest } from '../distribution/archive/integrity';

export type PackLocalPluginResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      title: string;
      version: string;
      packageRootPath: string;
      manifestPath: string;
      manifestDigest: string;
      archivePath: string;
      archiveDigest: string;
      archiveIntegrity: string;
      digestPath: string;
      archiveSizeBytes: number;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

function createDiagnostic(message: string): PluginCompatibilityDiagnostic {
  return {
    code: 'plugin_manifest_invalid',
    message,
  };
}

function sanitizeArchiveSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'plugin';
}

function defaultArchiveFileName(pluginId: string, version: string): string {
  return `${sanitizeArchiveSegment(pluginId)}-${sanitizeArchiveSegment(version)}.happier-plugin.tgz`;
}

function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);
  return relativePath === '' || (relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function resolveArchivePath(params: Readonly<{
  outPath?: string | null;
  defaultFileName: string;
  defaultDirectory: string;
}>): Promise<string> {
  const rawOutPath = String(params.outPath ?? '').trim();
  if (!rawOutPath) {
    return resolve(params.defaultDirectory, params.defaultFileName);
  }

  const resolved = resolve(expandHomeDirPath(rawOutPath));
  try {
    const outputStat = await lstat(resolved);
    if (outputStat.isDirectory()) {
      return join(resolved, params.defaultFileName);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
  return resolved;
}

async function resolvePhysicalDestinationPath(destinationPath: string): Promise<string> {
  const missingParentSegments: string[] = [];
  let existingParentPath = dirname(destinationPath);

  while (true) {
    try {
      const physicalParentPath = await realpath(existingParentPath);
      return resolve(
        physicalParentPath,
        ...missingParentSegments.reverse(),
        basename(destinationPath),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const parentPath = dirname(existingParentPath);
      if (code !== 'ENOENT' || parentPath === existingParentPath) {
        throw error;
      }
      missingParentSegments.push(basename(existingParentPath));
      existingParentPath = parentPath;
    }
  }
}

function hashArchive(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sriSha512(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

type PackPackageContract = Readonly<{
  name: string;
  version: string;
  files: readonly string[];
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readPackPackageContract(params: Readonly<{
  packageRootPath: string;
  pluginVersion: string;
}>): Promise<PackPackageContract> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(params.packageRootPath, 'package.json'), 'utf8'));
  } catch {
    throw new Error('Plugin pack requires a valid package.json');
  }
  if (!isRecord(value)) throw new Error('Plugin package.json must contain an object');
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('Plugin package.json must declare a package name');
  }
  const packageName = normalizeNpmPackageName(value.name);
  if (value.version !== params.pluginVersion) {
    throw new Error('Plugin package.json version must match the canonical plugin manifest version');
  }
  if (!Array.isArray(value.keywords)
    || !value.keywords.every((keyword) => typeof keyword === 'string')
    || !value.keywords.includes('happier-plugin')) {
    throw new Error('Plugin package.json must declare the happier-plugin keyword');
  }
  if (!isRecord(value.happier) || value.happier.manifest !== '.happier-plugin/plugin.json') {
    throw new Error('Plugin package.json happier.manifest must be exactly .happier-plugin/plugin.json');
  }
  const files = readPortableNpmPackageFiles(value.files);
  return Object.freeze({ name: packageName, version: params.pluginVersion, files });
}

async function collectSelectedFiles(params: Readonly<{
  packageRootPath: string;
  selectors: readonly string[];
}>): Promise<readonly string[]> {
  const selected = new Set<string>();

  async function visit(relativePath: string): Promise<void> {
    const segments = relativePath.split('/');
    let absolutePath = params.packageRootPath;
    let stat: Awaited<ReturnType<typeof lstat>> | undefined;
    for (const segment of segments) {
      absolutePath = join(absolutePath, segment);
      try {
        stat = await lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          throw new Error(`package.json files entry does not exist: ${relativePath}`);
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Plugin selected files contain unsupported symbolic link '${relativePath}'`);
      }
    }
    if (!stat) throw new Error(`package.json files entry does not exist: ${relativePath}`);
    if (stat.isFile()) {
      selected.add(relativePath);
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Plugin selected path is not a regular file or directory: ${relativePath}`);
    }
    const entries = await readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      await visit(`${relativePath}/${entry.name}`);
    }
  }

  await visit('package.json');
  for (const selector of params.selectors) await visit(selector);
  return Object.freeze([...selected].sort((left, right) => left.localeCompare(right)));
}

async function writeStagedCanonicalManifest(params: Readonly<{
  manifest: CanonicalPluginManifest;
  stagedManifestPath: string;
}>): Promise<void> {
  await writeFile(params.stagedManifestPath, `${JSON.stringify(params.manifest, null, 2)}\n`, 'utf8');
}

function readManifestDisplayName(manifest: CanonicalPluginManifest): string {
  return typeof manifest.displayName === 'string'
    ? manifest.displayName
    : manifest.displayName.fallback;
}

export async function packLocalPlugin(params: Readonly<{
  locator: string;
  outPath?: string | null;
}>): Promise<PackLocalPluginResult> {
  const resolvedSource = await resolveLocalPathPluginSource({ locator: params.locator });
  if (!resolvedSource.ok) {
    return resolvedSource;
  }

  const archivePath = await resolveArchivePath({
    outPath: params.outPath,
    defaultDirectory: dirname(resolvedSource.pluginRootPath),
    defaultFileName: defaultArchiveFileName(resolvedSource.manifest.id, resolvedSource.manifest.version),
  });
  const resolvedArchivePath = resolve(archivePath);
  const physicalArchivePath = await resolvePhysicalDestinationPath(resolvedArchivePath);
  const digestPath = `${resolvedArchivePath}.sha256`;

  if (!resolvedArchivePath.endsWith('.tgz') && !resolvedArchivePath.endsWith('.tar.gz')) {
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(`Plugin pack output must use a .tgz or .tar.gz archive path: ${resolvedArchivePath}`),
      ],
    };
  }

  if (isPathInsideOrEqual(resolvedSource.pluginRootPath, physicalArchivePath)) {
    return {
      ok: false,
      diagnostics: [
        createDiagnostic('Plugin pack output must be outside the plugin package root'),
      ],
    };
  }

  if (await pathExists(resolvedArchivePath)) {
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(`Plugin pack output already exists: ${resolvedArchivePath}`),
      ],
    };
  }

  if (await pathExists(digestPath)) {
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(`Plugin pack digest output already exists: ${digestPath}`),
      ],
    };
  }

  const outputDir = dirname(resolvedArchivePath);
  await mkdir(outputDir, { recursive: true });
  const stagingDir = await mkdtemp(join(outputDir, '.happier-plugin-pack-'));
  const stagedRoot = join(stagingDir, 'package');
  try {
    const packageContract = await readPackPackageContract({
      packageRootPath: resolvedSource.pluginRootPath,
      pluginVersion: resolvedSource.manifest.version,
    });
    const selectedFiles = await collectSelectedFiles({
      packageRootPath: resolvedSource.pluginRootPath,
      selectors: packageContract.files,
    });
    for (const selectedFile of selectedFiles) {
      const destination = join(stagedRoot, ...selectedFile.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(resolvedSource.pluginRootPath, ...selectedFile.split('/')), destination, { force: true });
    }
    const stagedManifestPath = join(stagedRoot, '.happier-plugin', 'plugin.json');
    if (!selectedFiles.includes('.happier-plugin/plugin.json')) {
      throw new Error('package.json files must select .happier-plugin/plugin.json');
    }
    await writeStagedCanonicalManifest({
      manifest: resolvedSource.manifest,
      stagedManifestPath,
    });
    await tar.c({
      gzip: true,
      file: resolvedArchivePath,
      cwd: stagingDir,
      portable: true,
    }, ['package']);

    const archiveBytes = await readFile(resolvedArchivePath);
    const validationParentPath = join(stagingDir, 'validation');
    await mkdir(validationParentPath);
    const staged = await stageDownloadedNpmArtifactCandidate({
      candidate: Object.freeze({
        source: Object.freeze({
          kind: 'npm',
          registryOrigin: 'https://local-pack.invalid',
          packageName: packageContract.name,
          version: packageContract.version,
          integrity: sriSha512(archiveBytes),
          tarballUrl: pathToFileURL(resolvedArchivePath).href,
        }),
        artifactPath: resolvedArchivePath,
        byteLength: archiveBytes.byteLength,
        registrySignature: Object.freeze({ status: 'absent' }),
        provenance: Object.freeze({ status: 'absent' }),
      }),
      stagingParentPath: validationParentPath,
    });
    if (!staged.ok) {
      throw new Error(`Packed npm candidate rejected (${staged.rejection.code}): ${staged.rejection.message}`);
    }
    await cleanupStagedNpmArtifactCandidate(staged.candidate);
  } catch (error) {
    await rm(resolvedArchivePath, { force: true }).catch(() => undefined);
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(error instanceof Error ? error.message : 'Plugin pack failed'),
      ],
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const archiveBytes = await readFile(resolvedArchivePath);
  const archiveDigest = hashArchive(archiveBytes);
  await writeFile(digestPath, `${archiveDigest}  ${basename(resolvedArchivePath)}\n`, 'utf8');

  return {
    ok: true,
    pluginId: resolvedSource.manifest.id,
    title: readManifestDisplayName(resolvedSource.manifest),
    version: resolvedSource.manifest.version,
    packageRootPath: resolvedSource.pluginRootPath,
    manifestPath: resolvedSource.manifestPath,
    manifestDigest: resolvedSource.manifestDigest,
    archivePath: resolvedArchivePath,
    archiveDigest,
    archiveIntegrity: archiveSha256IntegrityFromDigest(archiveDigest),
    digestPath,
    archiveSizeBytes: archiveBytes.byteLength,
  };
}
