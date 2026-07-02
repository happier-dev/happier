import {
    PluginUiExecutableArtifactManifestV1Schema,
    type PluginUiExecutableArtifactManifestV1,
} from '@happier-dev/protocol';

import { deriveInstalledPluginUiArtifactCacheKey } from './cacheKeys';

export type PluginUiArtifactInstallValidationCode =
    | 'invalid_manifest'
    | 'plugin_id_mismatch'
    | 'contribution_id_mismatch'
    | 'artifact_revoked';

export type PluginUiArtifactInstallValidationResult =
    | Readonly<{ ok: true; artifact: PluginUiExecutableArtifactManifestV1; cacheKey: string }>
    | Readonly<{ ok: false; code: PluginUiArtifactInstallValidationCode }>;

export function validateInstalledPluginUiArtifactManifest(params: Readonly<{
    artifact: unknown;
    expectedPluginId: string;
    expectedContributionId: string;
    revokedDigests: ReadonlySet<string>;
}>): PluginUiArtifactInstallValidationResult {
    const parsed = PluginUiExecutableArtifactManifestV1Schema.safeParse(params.artifact);
    if (!parsed.success) {
        return Object.freeze({ ok: false, code: 'invalid_manifest' });
    }
    if (parsed.data.pluginId !== params.expectedPluginId) {
        return Object.freeze({ ok: false, code: 'plugin_id_mismatch' });
    }
    if (parsed.data.contributionId !== params.expectedContributionId) {
        return Object.freeze({ ok: false, code: 'contribution_id_mismatch' });
    }
    if (params.revokedDigests.has(parsed.data.integrity.digest)) {
        return Object.freeze({ ok: false, code: 'artifact_revoked' });
    }
    return Object.freeze({
        ok: true,
        artifact: parsed.data,
        cacheKey: deriveInstalledPluginUiArtifactCacheKey(parsed.data),
    });
}
