import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import type { ExtensionSourceSpecV1, PluginManifestV1 } from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '../shared/pluginDiagnostics';
import { readPluginManifest } from '../manifest/readPluginManifest';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '../store/pluginPaths';

export type ResolvedLocalPathPluginSource =
  | Readonly<{
      ok: true;
      pluginRootPath: string;
      manifestPath: string;
      manifestDigest: string;
      manifest: PluginManifestV1;
      sourceSpec: ExtensionSourceSpecV1;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

function expandTildePath(locator: string): string {
  if (!locator.startsWith('~')) {
    return locator;
  }
  const home = String(process.env.HOME ?? process.env.USERPROFILE ?? '').trim();
  if (!home) {
    return locator;
  }
  if (locator === '~') {
    return home;
  }
  if (locator.startsWith('~/') || locator.startsWith('~\\')) {
    return resolve(home, locator.slice(2));
  }
  return locator;
}

async function resolveCanonicalPath(locator: string): Promise<string | null> {
  const expanded = expandTildePath(String(locator ?? '').trim());
  if (!expanded) return null;
  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function resolveManifestLocation(canonicalPath: string, isFilePath: boolean): Readonly<{
  pluginRootPath: string;
  manifestPath: string;
}> {
  if (isFilePath) {
    const manifestDir = dirname(canonicalPath);
    const pluginRootPath = basename(manifestDir) === '.happier-plugin'
      ? dirname(manifestDir)
      : dirname(canonicalPath);
    return {
      pluginRootPath,
      manifestPath: canonicalPath,
    };
  }

  if (basename(canonicalPath) === '.happier-plugin') {
    return {
      pluginRootPath: dirname(canonicalPath),
      manifestPath: resolve(canonicalPath, 'plugin.json'),
    };
  }

  return {
    pluginRootPath: canonicalPath,
    manifestPath: resolve(canonicalPath, PLUGIN_MANIFEST_RELATIVE_PATH),
  };
}

export async function resolveLocalPathPluginSource(params: Readonly<{ locator: string }>): Promise<ResolvedLocalPathPluginSource> {
  const canonicalPath = await resolveCanonicalPath(params.locator);
  if (!canonicalPath) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_source_missing',
          message: `Plugin source path does not exist: ${params.locator}`,
        },
      ],
    };
  }

  const pathStat = await stat(canonicalPath);
  const sourceLocator = pathStat.isFile() ? canonicalPath : undefined;
  const { pluginRootPath, manifestPath } = resolveManifestLocation(canonicalPath, pathStat.isFile());
  const manifestRead = await readPluginManifest({ manifestPath });
  if (!manifestRead.ok) {
    return manifestRead;
  }

  return {
    ok: true,
    pluginRootPath,
    manifestPath: manifestRead.manifestPath,
    manifestDigest: manifestRead.manifestDigest,
    manifest: manifestRead.manifest,
    sourceSpec: {
      kind: 'path',
      locator: sourceLocator ?? pluginRootPath,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
      resolvedDigest: manifestRead.manifestDigest,
      resolvedVersion: manifestRead.manifest.version,
    },
  };
}
