import {
  PluginManifestV2Schema,
  type ParsedPluginManifestV2,
} from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from './types';

/**
 * Pre-v1 manifests have no compatibility rewrite stage. Hook and family inputs
 * are parsed exactly by the one protocol manifest schema.
 */
export function normalizeManifestHookRegistrations(input: unknown): unknown {
  return input;
}

export function normalizeParsedPluginManifestV2(manifest: ParsedPluginManifestV2): CanonicalPluginManifest {
  return Object.freeze({
    ...manifest,
    contributes: Object.freeze(manifest.contributes),
  });
}

export function normalizePluginManifestV2(input: unknown): CanonicalPluginManifest {
  return normalizeParsedPluginManifestV2(PluginManifestV2Schema.parse(input));
}

export function readCanonicalPluginManifest(input: unknown): CanonicalPluginManifest | null {
  const parsed = PluginManifestV2Schema.safeParse(input);
  return parsed.success ? normalizeParsedPluginManifestV2(parsed.data) : null;
}
