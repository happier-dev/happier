import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { validatePluginManifest } from './validate';
import type { CanonicalPluginManifest } from './types';

export type ReadPluginManifestResult =
  | Readonly<{
      ok: true;
      manifestPath: string;
      manifestRawText: string;
      manifestDigest: string;
      manifest: CanonicalPluginManifest;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly PluginCompatibilityDiagnostic[];
    }>;

function hashManifest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export async function readPluginManifest(params: Readonly<{ manifestPath: string }>): Promise<ReadPluginManifestResult> {
  let manifestRawText: string;
  try {
    manifestRawText = await readFile(params.manifestPath, 'utf8');
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

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(manifestRawText) as unknown;
  } catch {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'plugin_manifest_invalid',
          message: `Plugin manifest is not valid JSON: ${params.manifestPath}`,
        },
      ],
    };
  }

  const validation = validatePluginManifest(parsedJson);
  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    manifestPath: params.manifestPath,
    manifestRawText,
    manifestDigest: hashManifest(manifestRawText),
    manifest: validation.manifest,
  };
}
