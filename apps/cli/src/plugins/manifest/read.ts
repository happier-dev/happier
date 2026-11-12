import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { formatPluginManifestIngestionDiagnostic } from '@happier-dev/protocol/plugins/manifest/ingest';
import { decodePluginManifestUtf8 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { isReservedHappierPluginId } from '@happier-dev/protocol/plugins/plugin-id';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { ingestCanonicalPluginManifest, type PluginManifestReadPurpose } from './ingest';
import type { PluginSourceProvenance } from './sourceProvenance';
import type { CanonicalPluginManifest } from './types';
import { projectPluginManifestCompatibilityDiagnostic } from './diagnostics';

/** Npm generations retain the package.json whose identity acquisition verified. */
export async function readAdmittedGenerationNpmPackageName(generation: Readonly<{
  rootPath: string;
  record: Readonly<{ pluginId: string; sourceCustody?: Readonly<{ installSource: string }> }>;
}>): Promise<string | undefined> {
  if (!isReservedHappierPluginId(generation.record.pluginId)
    || generation.record.sourceCustody?.installSource !== 'npm') return undefined;
  const value: unknown = JSON.parse(await readFile(join(generation.rootPath, 'package.json'), 'utf8'));
  return value !== null && typeof value === 'object' && 'name' in value && typeof value.name === 'string'
    ? value.name : undefined;
}

export type ReadPluginManifestResult =
  | Readonly<{
      ok: true;
      manifestPath: string;
      manifestRawText: string;
      manifest: CanonicalPluginManifest;
      diagnostics?: readonly PluginCompatibilityDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

export async function readPluginManifest(params: Readonly<{
  manifestPath: string;
  manifestAuthority?: 'external' | 'bundled_first_party';
  /** See `PluginManifestValidationOptions.sourceProvenance`. */
  sourceProvenance: PluginSourceProvenance;
  registryPackageName?: string;
  enforceEngineCompatibility?: boolean;
  purpose?: PluginManifestReadPurpose;
}>): Promise<ReadPluginManifestResult> {
  let manifestRawBytes: Uint8Array;
  try {
    manifestRawBytes = await readFile(params.manifestPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'plugin_manifest_missing',
            message: `Plugin manifest not found at ${params.manifestPath}`,
          },
        ],
      };
    }
    throw error;
  }

  const ingestion = ingestCanonicalPluginManifest(manifestRawBytes, {
    ...(params.manifestAuthority ? { manifestAuthority: params.manifestAuthority } : {}),
    sourceProvenance: params.sourceProvenance,
    registryPackageName: params.registryPackageName,
    purpose: params.purpose ?? 'admission',
    ...(params.enforceEngineCompatibility !== undefined
      ? { enforceEngineCompatibility: params.enforceEngineCompatibility }
      : {}),
  });
  if (!ingestion.ok) {
    return {
      ok: false,
      diagnostics: ingestion.diagnostics.map((diagnostic) => ({
        ...projectPluginManifestCompatibilityDiagnostic(diagnostic),
        ...(diagnostic.code === 'plugin_manifest_engine_incompatible' || diagnostic.pluginId && diagnostic.contributionId ? {} : {
          message: `${diagnostic.code}: ${formatPluginManifestIngestionDiagnostic({ ...diagnostic, code: 'plugin_manifest_invalid' })}`,
        }),
      })),
    };
  }

  const manifestRawText = decodePluginManifestUtf8(manifestRawBytes);

  return {
    ok: true,
    manifestPath: params.manifestPath,
    manifestRawText,
    manifest: ingestion.manifest,
    ...(ingestion.diagnostics?.length ? { diagnostics: ingestion.diagnostics.map(projectPluginManifestCompatibilityDiagnostic) } : {}),
  };
}
