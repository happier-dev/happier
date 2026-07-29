import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import type { PluginSourceSpecV1 } from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { readPluginManifest } from '@/plugins/manifest/read';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '@/plugins/store/paths';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export type ResolvedLocalPathPluginSourceSuccess = Readonly<{
  ok: true;
  pluginRootPath: string;
  manifestPath: string;
  manifestDigest: string;
  manifest: CanonicalPluginManifest;
  sourceSpec: PluginSourceSpecV1;
}>;

export type ResolvedLocalPathPluginSourceFailure = Readonly<{
  ok: false;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;

export type ResolvedLocalPathPluginSource =
  | ResolvedLocalPathPluginSourceSuccess
  | ResolvedLocalPathPluginSourceFailure;

async function resolveCanonicalPath(locator: string): Promise<string | null> {
  const expanded = expandHomeDirPath(String(locator ?? '').trim());
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
  const rawLocator = String(params.locator ?? '').trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(rawLocator)) {
    try {
      const parsed = new URL(rawLocator);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return {
          ok: false,
          diagnostics: [
            {
              code: 'plugin_source_kind_unsupported',
              message: `Plugin source locator uses unsupported URL scheme '${parsed.protocol}' (${rawLocator})`,
            },
          ],
        };
      }
    } catch {
      // handled below by filesystem resolution
    }
  }

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
      trustPolicy: 'prompt',
      installPolicy: 'link',
      resolvedDigest: manifestRead.manifestDigest,
      resolvedVersion: manifestRead.manifest.version,
    },
  };
}
