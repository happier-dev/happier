import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import type { ParsedPluginManifestV2 } from '@happier-dev/protocol';
import { forwardPrecomputedDeclarationFields } from '@happier-dev/protocol/plugins/contributions/deferredDeclarationFields';

import type { CanonicalPluginManifest } from './types';

export function normalizeParsedPluginManifestV2(manifest: ParsedPluginManifestV2): CanonicalPluginManifest {
  const normalized = {
    ...manifest,
    contributes: Object.freeze(manifest.contributes),
  };
  // Normalization freezes these exact values; it changes no declaration bytes.
  forwardPrecomputedDeclarationFields(manifest, normalized);
  return Object.freeze(normalized);
}

export function normalizePluginManifestV2(input: unknown): CanonicalPluginManifest {
  return normalizeParsedPluginManifestV2(PluginManifestV2Schema.parse(input));
}

export function readCanonicalPluginManifest(input: unknown): CanonicalPluginManifest | null {
  const parsed = PluginManifestV2Schema.safeParse(input);
  return parsed.success ? normalizeParsedPluginManifestV2(parsed.data) : null;
}
