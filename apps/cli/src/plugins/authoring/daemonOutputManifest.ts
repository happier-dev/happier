import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { realpathNearestExistingAncestor } from './physicalAncestorPath';

/**
 * The authoring bundler is the owner of this small transition record. It is
 * deliberately kept beside the canonical plugin manifest so a descriptor
 * build can remove only executable files emitted by the preceding bundle.
 */
export const PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH =
  '.happier-plugin/.happier-daemon-outputs.json';

const PLUGIN_DAEMON_OUTPUT_MANIFEST_VERSION = 1;

type PluginDaemonOutputManifest = Readonly<{
  version: 1;
  outputs: readonly string[];
}>;

/** Check a project-relative path without following a symlinked project child. */
async function assertContainedNoFollowPath(params: Readonly<{
  projectRoot: string;
  targetPath: string;
  label: string;
  physicalProjectRoot?: string;
}>): Promise<void> {
  const projectRoot = resolve(params.projectRoot);
  const targetPath = resolve(params.targetPath);
  if (!isCanonicalAbsolutePathInsideRoot(projectRoot, targetPath)) {
    throw new Error(`${params.label} escaped its project root`);
  }

  const physicalProjectRoot = params.physicalProjectRoot ?? await realpath(projectRoot);
  const physicalAncestor = await realpathNearestExistingAncestor(targetPath);
  if (!isCanonicalAbsolutePathInsideRoot(physicalProjectRoot, physicalAncestor)) {
    throw new Error(`${params.label} resolves outside the physical plugin root`);
  }

  const relativeTargetPath = relative(projectRoot, targetPath);
  let currentPath = projectRoot;
  for (const segment of relativeTargetPath ? relativeTargetPath.split(sep) : []) {
    currentPath = join(currentPath, segment);
    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`${params.label} contains a symbolic link`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function normalizeOutputRelativePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Plugin daemon output manifest contains a non-string output path');
  }
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Plugin daemon output manifest contains a non-portable output path: '${value}'`);
  }
  const normalizedMarkerPath = process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
  const markerPath = process.platform === 'win32'
    ? PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH.toLowerCase()
    : PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH;
  if (normalizedMarkerPath === markerPath) {
    throw new Error('Plugin daemon output manifest cannot claim its own path');
  }
  return normalized;
}

function normalizeOutputPaths(values: unknown): readonly string[] {
  if (!Array.isArray(values)) {
    throw new Error('Plugin daemon output manifest outputs must be an array');
  }
  const outputs = [...new Set(values.map(normalizeOutputRelativePath))];
  outputs.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return Object.freeze(outputs);
}

function manifestPath(projectRoot: string): string {
  return join(projectRoot, ...PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH.split('/'));
}

function parseManifest(raw: string): PluginDaemonOutputManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Plugin daemon output manifest is not valid JSON');
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as Readonly<Record<string, unknown>>).version !== PLUGIN_DAEMON_OUTPUT_MANIFEST_VERSION
  ) {
    throw new Error('Plugin daemon output manifest has an unsupported version');
  }
  return Object.freeze({
    version: 1,
    outputs: normalizeOutputPaths((parsed as Readonly<Record<string, unknown>>).outputs),
  });
}

/** Read the prior bundle's owned outputs. Missing ownership is valid. */
export async function readPluginDaemonOutputManifest(
  projectRootInput: string,
): Promise<PluginDaemonOutputManifest | null> {
  const projectRoot = resolve(projectRootInput);
  const outputManifestPath = manifestPath(projectRoot);
  await assertContainedNoFollowPath({
    projectRoot,
    targetPath: outputManifestPath,
    label: 'Plugin daemon output manifest',
  });
  try {
    return parseManifest(await readFile(outputManifestPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Persist the exact output set produced by one executable authoring bundle. */
export async function writePluginDaemonOutputManifest(params: Readonly<{
  projectRoot: string;
  outputRelativePaths: readonly string[];
}>): Promise<void> {
  const projectRoot = resolve(params.projectRoot);
  const outputs = normalizeOutputPaths(params.outputRelativePaths);
  const outputManifestPath = manifestPath(projectRoot);
  await assertContainedNoFollowPath({
    projectRoot,
    targetPath: outputManifestPath,
    label: 'Plugin daemon output manifest',
  });
  await mkdir(dirname(outputManifestPath), { recursive: true });
  await assertContainedNoFollowPath({
    projectRoot,
    targetPath: outputManifestPath,
    label: 'Plugin daemon output manifest',
  });
  await writeFile(
    outputManifestPath,
    `${JSON.stringify({ version: PLUGIN_DAEMON_OUTPUT_MANIFEST_VERSION, outputs }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Remove only the files claimed by the prior bundle, then retire the claim.
 * Unknown files are intentionally left alone: descriptor source may own other
 * JavaScript under dist and cannot be inferred from a package files glob.
 */
export async function cleanupPluginDaemonOutputManifest(projectRootInput: string): Promise<void> {
  const projectRoot = resolve(projectRootInput);
  // No marker means no owned executable output to retire. Check that cheap
  // lexical path first so callers that have not created a project tree yet do
  // not turn the absence of ownership into a filesystem error.
  if (!existsSync(manifestPath(projectRoot))) return;
  const physicalProjectRoot = await realpath(projectRoot);
  const manifest = await readPluginDaemonOutputManifest(projectRoot);
  if (!manifest) return;

  const outputManifestPath = manifestPath(projectRoot);
  await assertContainedNoFollowPath({
    projectRoot,
    targetPath: outputManifestPath,
    label: 'Plugin daemon output manifest',
    physicalProjectRoot,
  });

  const removableOutputPaths: string[] = [];
  for (const outputRelativePath of manifest.outputs) {
    const outputPath = resolve(projectRoot, ...outputRelativePath.split('/'));
    await assertContainedNoFollowPath({
      projectRoot,
      targetPath: outputPath,
      label: `Plugin daemon output manifest path '${outputRelativePath}'`,
      physicalProjectRoot,
    });
    try {
      const outputStat = await lstat(outputPath);
      if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
        throw new Error(`Plugin daemon output manifest path is not a regular file: '${outputRelativePath}'`);
      }
      if (!isCanonicalAbsolutePathInsideRoot(physicalProjectRoot, await realpath(outputPath))) {
        throw new Error(`Plugin daemon output manifest path escaped its physical project root: '${outputRelativePath}'`);
      }
      removableOutputPaths.push(outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
      throw error;
    }
  }

  for (const outputPath of removableOutputPaths) {
    try {
      await unlink(outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    }
  }
  await unlink(outputManifestPath);
}

export function isPluginDaemonOutputManifestPath(relativePath: string): boolean {
  return relativePath.replaceAll('\\', '/')
    === PLUGIN_DAEMON_OUTPUT_MANIFEST_RELATIVE_PATH;
}
