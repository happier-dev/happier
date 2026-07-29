import type {
  PluginContributionIntrospectionProjectionV1,
  PluginDiagnosticHostV1,
} from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { enrichPluginDiagnosticRecord, projectPluginContributionIntrospection } from './project';
import { projectManifestContributionIntrospection } from './manifest';
import { mapPluginSourceToDiagnosticSource } from './source';

export function projectPluginCatalogEntryIntrospection(params: Readonly<{
  pluginId: string;
  pluginVersion: string;
  source: Readonly<{ kind: string; devWatch?: boolean }>;
  manifest: CanonicalPluginManifest | null;
  generation: number;
  host: PluginDiagnosticHostV1;
  platform: string;
  occurredAtMs: number;
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>): PluginContributionIntrospectionProjectionV1 {
  const source = mapPluginSourceToDiagnosticSource(params.source);
  if (params.manifest) {
    return projectManifestContributionIntrospection({
      manifest: params.manifest,
      source,
      generation: params.generation,
      host: params.host,
      platform: params.platform,
      occurredAtMs: params.occurredAtMs,
      diagnostics: params.diagnostics,
    });
  }

  const diagnostics = params.diagnostics.map((diagnostic, ordinal) => enrichPluginDiagnosticRecord({
    code: diagnostic.code,
    severity: 'error',
    message: diagnostic.message,
  }, {
    ordinal,
    plugin: { id: params.pluginId, version: params.pluginVersion, source },
    stage: 'discovery',
    host: params.host,
    platform: params.platform,
    occurredAtMs: params.occurredAtMs,
  }));
  return projectPluginContributionIntrospection({
    generation: params.generation,
    candidates: [],
    diagnostics,
  });
}
