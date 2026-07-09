import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import * as tar from 'tar';

import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import { normalizePluginManifestSourceForArtifact } from '@/plugins/manifest/normalize';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

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

async function findFirstSymbolicLink(rootPath: string): Promise<string | null> {
  const pending = [rootPath];
  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) {
      continue;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        return relative(rootPath, entryPath) || entry.name;
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return null;
}

function hashArchive(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function writeStagedCanonicalManifest(params: Readonly<{
  sourceManifestPath: string;
  stagedManifestPath: string;
}>): Promise<void> {
  const raw = await readFile(params.sourceManifestPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const normalized = normalizePluginManifestSourceForArtifact(parsed);
  if (!normalized) {
    throw new Error('Plugin manifest did not normalize after validation');
  }
  await writeFile(params.stagedManifestPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
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
  const digestPath = `${resolvedArchivePath}.sha256`;

  if (!resolvedArchivePath.endsWith('.tgz') && !resolvedArchivePath.endsWith('.tar.gz')) {
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(`Plugin pack output must use a .tgz or .tar.gz archive path: ${resolvedArchivePath}`),
      ],
    };
  }

  if (isPathInsideOrEqual(resolvedSource.pluginRootPath, resolvedArchivePath)) {
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

  const firstSymlink = await findFirstSymbolicLink(resolvedSource.pluginRootPath);
  if (firstSymlink) {
    return {
      ok: false,
      diagnostics: [
        createDiagnostic(`Plugin package root contains unsupported symbolic link '${firstSymlink}'`),
      ],
    };
  }

  const outputDir = dirname(resolvedArchivePath);
  await mkdir(outputDir, { recursive: true });
  const stagingDir = await mkdtemp(join(outputDir, '.happier-plugin-pack-'));
  const archiveRootName = sanitizeArchiveSegment(`${resolvedSource.manifest.id}-${resolvedSource.manifest.version}`);
  const stagedRoot = join(stagingDir, archiveRootName);
  try {
    await cp(resolvedSource.pluginRootPath, stagedRoot, {
      recursive: true,
      force: true,
    });
    await writeStagedCanonicalManifest({
      sourceManifestPath: resolvedSource.manifestPath,
      stagedManifestPath: join(stagedRoot, '.happier-plugin', 'plugin.json'),
    });
    await tar.c({
      gzip: true,
      file: resolvedArchivePath,
      cwd: stagingDir,
      portable: true,
    }, [archiveRootName]);
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
    title: resolvedSource.manifest.displayName,
    version: resolvedSource.manifest.version,
    packageRootPath: resolvedSource.pluginRootPath,
    manifestPath: resolvedSource.manifestPath,
    manifestDigest: resolvedSource.manifestDigest,
    archivePath: resolvedArchivePath,
    archiveDigest,
    digestPath,
    archiveSizeBytes: archiveBytes.byteLength,
  };
}
