import { resolve } from 'node:path';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { PLUGIN_MANIFEST_RELATIVE_PATH } from '@/plugins/store/paths';
import type { PluginStateRecord } from '@/plugins/store/state';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { resolveLocalPathPluginSource, type ResolvedLocalPathPluginSource } from './localPath';

export type ResolvedPluginSource =
  | ResolvedLocalPathPluginSource
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

export async function resolveInstalledPluginSource(params: Readonly<{
  record: PluginStateRecord;
  approvedAuthorityManifest?: CanonicalPluginManifest;
}>): Promise<ResolvedPluginSource> {
  const { record, approvedAuthorityManifest } = params;
  if (record.source.kind === 'path' && record.source.devWatch === true) {
    // The daemon commits this projection with the accepted development source.
    // Current author bytes may not have been accepted yet and are not JSON.
    if (!approvedAuthorityManifest) {
      return {
        ok: false,
        diagnostics: [{
          code: 'plugin_manifest_missing',
          message: `Development plugin '${record.source.locator}' has no accepted manifest projection`,
        }],
      };
    }
    return {
      ok: true,
      pluginRootPath: record.source.resolvedPath,
      manifestPath: record.source.manifestPath,
      manifestAuthority: 'external',
      manifest: approvedAuthorityManifest,
      sourceSpec: { ...record.source, resolvedVersion: approvedAuthorityManifest.version },
    };
  }

  // Preserve standalone JSON-manifest overrides and resolve managed artifacts
  // from their materialized installation, not their acquisition locator.
  const defaultManifestPath = resolve(record.source.locator, PLUGIN_MANIFEST_RELATIVE_PATH);
  const locator = record.install.mode === 'managed_install'
    ? record.install.installedPath
    : record.source.manifestPath && record.source.manifestPath !== defaultManifestPath
      ? record.source.manifestPath
      : record.source.locator;
  if (typeof locator !== 'string' || locator.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [{
        code: 'plugin_manifest_semantic_invalid',
        message: `Plugin state for '${record.source.locator}' is missing a resolvable install path`,
      }],
    };
  }
  return await resolveLocalPathPluginSource({ locator, installedSourceKind: record.source.kind });
}
