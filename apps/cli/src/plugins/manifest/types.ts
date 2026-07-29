import type { ParsedPluginManifestV2 } from '@happier-dev/protocol';

export type CanonicalPluginManifestContributes = ParsedPluginManifestV2['contributes'];
export type CanonicalPluginManifest = Readonly<ParsedPluginManifestV2>;
