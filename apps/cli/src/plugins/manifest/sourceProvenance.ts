import { z } from 'zod';

import {
  isRegistryCustodiedPluginSourceKind,
  type PluginSourceKindV1,
} from '@happier-dev/protocol';

import type { PluginDistributionIdentity } from '@/plugins/store/install/trustIdentity';

/**
 * Provenance of the record a manifest's bytes came from. It scopes the two
 * manifest rules that only describe a *published* artifact — the reserved
 * `happier.*` namespace and the release-stamped engine range. See
 * `PluginManifestValidationOptions.sourceProvenance`.
 *
 * This is derived from what the record IS, never re-verified from the bytes:
 * a daemon-owned generation is a symlink-free copy with no dev marker left in
 * it, so there is nothing on disk to re-derive it from.
 */
export const PluginSourceProvenanceSchema = z.enum(['registryCustodied', 'localSource']);
export type PluginSourceProvenance = z.infer<typeof PluginSourceProvenanceSchema>;

/**
 * An absent source kind means the bytes are not an installed registry record —
 * a working tree, a bundled host contribution, or an in-flight local candidate
 * — none of which is registry-custodied.
 */
export function pluginSourceProvenanceForKind(
  kind: PluginSourceKindV1 | undefined,
): PluginSourceProvenance {
  return kind !== undefined && isRegistryCustodiedPluginSourceKind(kind)
    ? 'registryCustodied'
    : 'localSource';
}

const PLUGIN_SOURCE_KIND_BY_DISTRIBUTION_KIND = {
  npm: 'package',
  localPath: 'path',
  archive: 'archive',
} as const satisfies Record<PluginDistributionIdentity['kind'], PluginSourceKindV1>;

/**
 * The acquisition identity a record was admitted under is the same fact its
 * source kind carries, so both routes resolve through one decision.
 */
export function pluginSourceProvenanceForDistribution(
  distribution: PluginDistributionIdentity,
): PluginSourceProvenance {
  return pluginSourceProvenanceForKind(
    PLUGIN_SOURCE_KIND_BY_DISTRIBUTION_KIND[distribution.kind],
  );
}
