import type { PluginSourceSpecV1 } from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { resolveLocalPathPluginSource, type ResolvedLocalPathPluginSource } from './localPath';

export type ResolvedPluginSource =
  | ResolvedLocalPathPluginSource
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

export async function resolvePluginSource(params: Readonly<{
  source: PluginSourceSpecV1;
  manifestPathHint?: string;
}>): Promise<ResolvedPluginSource> {
  if (params.source.kind === 'path') {
    if (params.manifestPathHint) {
      const resolvedFromManifestPath = await resolveLocalPathPluginSource({
        locator: params.manifestPathHint,
      });
      if (resolvedFromManifestPath.ok || resolvedFromManifestPath.diagnostics[0]?.code !== 'plugin_source_missing') {
        return resolvedFromManifestPath;
      }
    }

    return await resolveLocalPathPluginSource({
      locator: params.source.locator,
    });
  }

  return {
    ok: false,
    diagnostics: [
      {
        code: 'plugin_source_kind_unsupported',
        message: `Unsupported plugin source kind for Wave 1: ${params.source.kind}`,
      },
    ],
  };
}
