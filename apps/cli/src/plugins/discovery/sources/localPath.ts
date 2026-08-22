import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type { PluginSourceSpecV1 } from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { resolveLocalPluginSourceManifestAuthority } from '@/plugins/manifest/bundledFirstPartyAuthority';
import { readPluginManifest } from '@/plugins/manifest/read';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '@/plugins/store/paths';
import { resolveAbsolutePathFromWorkingDirectory } from '@/utils/path/expandHomeDirPath';

export type ResolvedLocalPathPluginSourceSuccess = Readonly<{
  ok: true;
  pluginRootPath: string;
  manifestPath: string;
  /**
   * The authority this exact source root carries, decided once here from what
   * the path actually is. Every later reader of these same bytes - the daemon
   * candidate staged from them, and the installed manifest they became -
   * inherits this decision instead of re-defaulting to `external`.
   */
  manifestAuthority: 'external' | 'bundled_first_party';
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
  const absolute = resolveAbsolutePathFromWorkingDirectory(locator);
  if (absolute === null) return null;
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

export async function resolveLocalPathPluginSource(params: Readonly<{
  locator: string;
  /**
   * The authority already derived for the canonical source root these exact
   * bytes came from. An operation-local copy of a first-party source root is
   * still that root's bytes, but it no longer sits inside the checkout the
   * canonical predicate inspects, so the copy inherits the decision instead of
   * silently re-defaulting to `external`.
   */
  inheritedManifestAuthority?: 'external' | 'bundled_first_party';
}>): Promise<ResolvedLocalPathPluginSource> {
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
  const manifestAuthority = params.inheritedManifestAuthority
    ?? await resolveLocalPluginSourceManifestAuthority({ pluginRootPath });
  const manifestRead = await readPluginManifest({ manifestPath, manifestAuthority });
  if (!manifestRead.ok) {
    return manifestRead;
  }

  return {
    ok: true,
    pluginRootPath,
    manifestPath: manifestRead.manifestPath,
    manifestAuthority,
    manifest: manifestRead.manifest,
    sourceSpec: {
      kind: 'path',
      locator: sourceLocator ?? pluginRootPath,
      trustPolicy: 'prompt',
      installPolicy: 'link',
      resolvedVersion: manifestRead.manifest.version,
    },
  };
}
