import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import type { PluginSourceCustodyV1 } from '../runtime/sourceCustody.js';
import type { PluginPortableReleaseManifestV1 } from './compatibilityProjectionV1.js';
import type { PluginAccountAvailabilityIntentReadResponseV1, PluginReleaseFactsV1 } from './v1.js';

/** Host-selected declarations are trusted code, not content-based grants.
 * Account policy and the invoking host's occurrence lifetime own admission.
 */
export function createPluginAccountBundledSelectionV1(input: Readonly<{
  packageName: string;
  manifest: PluginPortableReleaseManifestV1;
  sourceCustody?: PluginSourceCustodyV1;
}>): Readonly<{
  manifest: PluginPortableReleaseManifestV1;
  sourceCustody: PluginSourceCustodyV1;
  custodyId: string;
}> {
  return Object.freeze({
    manifest: input.manifest,
    sourceCustody: input.sourceCustody ?? Object.freeze({
      kind: 'bundled_first_party' as const,
      packagedRuntime: Object.freeze({ kind: 'source_declaration' as const, packageName: input.packageName }),
    }),
    custodyId: JSON.stringify([input.packageName, input.manifest.id, input.manifest.version]),
  });
}

export type PluginAccountExecutionSelectionV1 =
  | Readonly<{
      kind: 'available';
      manifest: PluginPortableReleaseManifestV1;
      sourceCustody: Extract<PluginSourceCustodyV1, Readonly<{ kind: 'account_release' | 'bundled_first_party' }>>;
      custodyId: string;
      release: PluginReleaseFactsV1 | null;
    }>
  | Readonly<{
      kind: 'unavailable';
      code: 'plugin_disabled' | 'plugin_release_unavailable' | 'plugin_account_execution_unavailable';
    }>;

/**
 * One Account selection policy for invoking hosts. Acquisition validates and
 * snapshots canonical release facts; callers prove the captured Account read is
 * loaded. This policy runs afresh without repeating that immutable acquisition.
 */
export function resolvePluginAccountExecutionSelectionV1(input: Readonly<{
  pluginId: string;
  intentRead: PluginAccountAvailabilityIntentReadResponseV1 | null;
  bundled?: Readonly<{
    manifest: PluginPortableReleaseManifestV1;
    sourceCustody: PluginSourceCustodyV1;
    custodyId: string;
  }>;
}>): PluginAccountExecutionSelectionV1 {
  const intent = input.intentRead?.intent;
  if (intent && intent.pluginId !== input.pluginId) {
    return { kind: 'unavailable', code: 'plugin_release_unavailable' };
  }
  if (intent?.enabled === false) return { kind: 'unavailable', code: 'plugin_disabled' };
  if (intent?.desiredVersion) {
    const release = input.intentRead?.release;
    if (!release || release.ref.pluginId !== input.pluginId || release.ref.version !== intent.desiredVersion) {
      return { kind: 'unavailable', code: 'plugin_release_unavailable' };
    }
    const sourceCustody: PluginSourceCustodyV1 = Object.freeze({
      kind: 'account_release', pluginId: release.ref.pluginId,
      version: release.ref.version, archiveDigestSha256: release.archiveDigestSha256,
    });
    return Object.freeze({ kind: 'available', manifest: release.normalizedManifest,
      sourceCustody, custodyId: createCanonicalJsonSigningInput(sourceCustody), release });
  }
  if (!input.bundled || input.bundled.manifest.id !== input.pluginId
    || input.bundled.sourceCustody.kind !== 'bundled_first_party' || !input.bundled.custodyId.trim()) {
    return { kind: 'unavailable', code: 'plugin_account_execution_unavailable' };
  }
  return Object.freeze({ kind: 'available',
    // Acquisition already parsed this typed declaration. Currentness checks run
    // per host method; rewalking/cloning its contribution graph stalls the UI.
    manifest: input.bundled.manifest,
    sourceCustody: input.bundled.sourceCustody, custodyId: input.bundled.custodyId, release: null });
}
