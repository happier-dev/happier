import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';
import { isDynamicPluginResourceContributionV2 } from '@happier-dev/protocol/plugins/contributions/v2';
import type { PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';
import { digestBuildInputRecordManifest, WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } from '@happier-dev/cli-common/packageBuildOutputTargets';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

export const GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH = 'dist/happier-plugin-ui';
export const GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH =
  `${GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH}/ui-artifacts.json`;

function parseGeneratedPluginUiArtifactsManifest(
  raw: string,
): PluginUiArtifactsManifestV2 | null {
  try {
    const parsed = PluginUiArtifactsManifestV2Schema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reads the generated executable UI graph from one installed plugin generation. */
export async function readGeneratedPluginUiArtifactsManifest(
  pluginRootPath: string,
): Promise<PluginUiArtifactsManifestV2 | null> {
  let raw: string;
  try {
    raw = await readFile(
      join(pluginRootPath, ...GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH.split('/')),
      'utf8',
    );
  } catch {
    return null;
  }

  return parseGeneratedPluginUiArtifactsManifest(raw);
}

/** Reads the same generated graph for synchronously projected bundled packages. */
export function readGeneratedPluginUiArtifactsManifestSync(
  pluginRootPath: string,
): PluginUiArtifactsManifestV2 | null {
  let raw: string;
  try {
    raw = readFileSync(
      join(pluginRootPath, ...GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH.split('/')),
      'utf8',
    );
  } catch {
    return null;
  }

  return parseGeneratedPluginUiArtifactsManifest(raw);
}

/**
 * The build owner writes this beside the adopted graph, including after retaining an older build.
 * A bundled record is part of our own build: its writer validated the manifest with the canonical
 * validator and stored its digest, so while the manifest still has that digest it is not validated
 * again at every cold start. Installed and third-party records are always validated (trust boundary).
 */
export function readGeneratedPluginCompiledAccountResourceIdsSync(
  pluginRootPath: string, pluginId: string, origin: 'bundled' | 'installed',
): readonly string[] | null {
  try {
    const record: unknown = JSON.parse(readFileSync(join(pluginRootPath, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH,
      WORKSPACE_PACKAGE_BUILD_INPUT_RECORD), 'utf8'));
    if (!record || typeof record !== 'object' || !('version' in record) || record.version !== 2 || !('manifest' in record)) return null;
    const buildValidated = origin === 'bundled' && 'manifestDigest' in record && typeof record.manifestDigest === 'string'
      && record.manifestDigest === digestBuildInputRecordManifest(record.manifest);
    const manifest = buildValidated
      ? record.manifest as Pick<CanonicalPluginManifest, 'id' | 'contributes'>
      : readCanonicalPluginManifest(record.manifest);
    if (manifest?.id !== pluginId) return null;
    // Loaded declarations live for the registry's lifetime. The projection only
    // needs these IDs, not a second copy of every compiled Action schema.
    return Object.freeze(manifest.contributes.resources.flatMap(resource =>
      isDynamicPluginResourceContributionV2(resource) && resource.execution?.target === 'account' ? [resource.id] : []));
  } catch {
    return null;
  }
}
