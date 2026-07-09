import {
    hasPluginUiExecutableArtifactIntegrityV1,
    PluginUiExecutableArtifactManifestV1Schema,
    type PluginUiExecutableArtifactManifestWithIntegrityV1,
} from '@happier-dev/protocol';

import { deriveInstalledPluginUiArtifactCacheKey } from './cacheKeys';
import {
    createPluginUiArtifactRevocationState,
    isPluginUiArtifactRevoked,
    mergePluginUiArtifactRevocationStates,
    type PluginUiArtifactRevocationState,
} from './revocation';

export type PluginUiArtifactInstallValidationCode =
    | 'invalid_manifest'
    | 'plugin_id_mismatch'
    | 'contribution_id_mismatch'
    | 'artifact_revoked';

export type PluginUiArtifactInstallValidationResult =
    | Readonly<{ ok: true; artifact: PluginUiExecutableArtifactManifestWithIntegrityV1; cacheKey: string }>
    | Readonly<{ ok: false; code: PluginUiArtifactInstallValidationCode }>;

export function validateInstalledPluginUiArtifactManifest(params: Readonly<{
    artifact: unknown;
    expectedPluginId: string;
    expectedContributionId: string;
    revokedDigests: ReadonlySet<string>;
    revocationState?: PluginUiArtifactRevocationState;
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
    if (!hasPluginUiExecutableArtifactIntegrityV1(parsed.data)) {
        return Object.freeze({ ok: false, code: 'invalid_manifest' });
    }
    const revocationState = mergePluginUiArtifactRevocationStates(
        createPluginUiArtifactRevocationState({ revokedDigests: params.revokedDigests }),
        ...(params.revocationState ? [params.revocationState] : []),
    );
    if (isPluginUiArtifactRevoked({
        pluginId: parsed.data.pluginId,
        contributionId: parsed.data.contributionId,
        digest: parsed.data.integrity.digest,
        ...(parsed.data.integrity.signingKeyId ? { signingKeyId: parsed.data.integrity.signingKeyId } : {}),
        ...(parsed.data.installSourceId ? { installSourceId: parsed.data.installSourceId } : {}),
    }, revocationState)) {
        return Object.freeze({ ok: false, code: 'artifact_revoked' });
    }
    return Object.freeze({
        ok: true,
        artifact: parsed.data,
        cacheKey: deriveInstalledPluginUiArtifactCacheKey(parsed.data),
    });
}
