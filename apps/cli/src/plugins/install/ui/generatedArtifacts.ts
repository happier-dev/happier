import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PluginUiArtifactsManifestV1Schema,
  type PluginUiArtifactsManifestV1,
} from '@happier-dev/protocol/plugins/ui';

export const GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH = 'dist/happier-plugin-ui';
export const GENERATED_PLUGIN_UI_ARTIFACTS_MANIFEST_RELATIVE_PATH =
  `${GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH}/ui-artifacts.json`;

function parseGeneratedPluginUiArtifactsManifest(
  raw: string,
): PluginUiArtifactsManifestV1 | null {
  try {
    const parsed = PluginUiArtifactsManifestV1Schema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reads the generated executable UI graph from one installed plugin generation. */
export async function readGeneratedPluginUiArtifactsManifest(
  pluginRootPath: string,
): Promise<PluginUiArtifactsManifestV1 | null> {
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
): PluginUiArtifactsManifestV1 | null {
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
