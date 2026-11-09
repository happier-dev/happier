import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PluginUiArtifactsManifestV2Schema } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';
import type { PluginUiArtifactsManifestV2 } from '@happier-dev/protocol/plugins/ui';
import { WORKSPACE_PACKAGE_BUILD_INPUT_RECORD } from '@happier-dev/cli-common/packageBuildOutputTargets';
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

/** The build owner writes this beside the adopted graph, including after retaining an older build. */
export function readGeneratedPluginCompiledManifestSync(pluginRootPath: string, pluginId: string): CanonicalPluginManifest | null {
  try {
    const record: unknown = JSON.parse(readFileSync(join(pluginRootPath, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH,
      WORKSPACE_PACKAGE_BUILD_INPUT_RECORD), 'utf8'));
    if (!record || typeof record !== 'object' || !('version' in record) || record.version !== 2 || !('manifest' in record)) return null;
    const manifest = readCanonicalPluginManifest(record.manifest);
    return manifest?.id === pluginId ? manifest : null;
  } catch {
    return null;
  }
}
