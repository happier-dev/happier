import {
    hasPluginUiExecutableArtifactIntegrityV1,
    PluginUiExecutableArtifactManifestV1Schema,
    type PluginUiExecutableArtifactManifestV1,
    type PluginUiExecutableArtifactManifestWithIntegrityV1,
    type PluginUiArtifactTrustRootV1,
} from '@happier-dev/protocol';

import {
    createPluginUiArtifactTrustDiagnostic,
    validatePluginUiArtifactExecutionTrust,
    type PluginUiArtifactExecutionTrust,
} from './artifactSigning';
import { deriveInstalledPluginUiArtifactCacheKey } from './cacheKeys';
import {
    createPluginUiArtifactRevocationState,
    isPluginUiArtifactRevoked,
    mergePluginUiArtifactRevocationStates,
    type PluginUiArtifactRevocationState,
} from './revocation';

export type EmbeddedWebBundleHostRuntime = Readonly<{
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    platform: 'web';
    channel: string;
    projectionGeneration: number;
}>;

export type EmbeddedWebBundleCacheIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactDigest: string;
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    platform: 'web';
    channel: string;
    projectionGeneration: number;
}>;

export type EmbeddedWebBundleInstallValidationCode =
    | 'invalid_manifest'
    | 'not_embedded_web_bundle'
    | 'plugin_id_mismatch'
    | 'contribution_id_mismatch'
    | 'artifact_revoked'
    | 'execution_trust_unverified'
    | 'signature_verification_unavailable'
    | 'signature_required'
    | 'signing_key_required'
    | 'signature_mismatch'
    | 'signing_key_mismatch'
    | 'remote_url_unsupported'
    | 'installed_asset_missing'
    | 'unsupported_content_type'
    | 'runtime_mismatch'
    | 'channel_unsupported';

export type EmbeddedWebBundleInstallValidationResult =
    | Readonly<{
        ok: true;
        artifact: PluginUiExecutableArtifactManifestWithIntegrityV1;
        cacheKey: string;
        cacheIdentity: EmbeddedWebBundleCacheIdentity;
    }>
    | Readonly<{ ok: false; code: EmbeddedWebBundleInstallValidationCode; diagnostics?: readonly string[] }>;

function runtimeMatches(
    artifact: PluginUiExecutableArtifactManifestV1,
    hostRuntime: EmbeddedWebBundleHostRuntime,
): boolean {
    const compatibility = artifact.compatibility;
    return artifact.platform === hostRuntime.platform
        && compatibility.hostAppVersion === hostRuntime.hostAppVersion
        && compatibility.hostUiApiVersion === hostRuntime.hostUiApiVersion
        && compatibility.reactVersion === hostRuntime.reactVersion;
}

function channelSupported(
    artifact: PluginUiExecutableArtifactManifestV1,
    hostRuntime: EmbeddedWebBundleHostRuntime,
    executionTrust: PluginUiArtifactExecutionTrust | undefined,
): boolean {
    const declared: readonly string[] | undefined = artifact.compatibility.supportedChannels;
    if (declared && declared.length > 0) {
        return declared.includes(hostRuntime.channel);
    }
    const isFirstParty = executionTrust?.kind === 'trustedSource' && executionTrust.reason === 'first_party';
    return isFirstParty && artifact.channel === hostRuntime.channel;
}

function isSupportedJavaScriptContentType(contentType: string): contentType is 'text/javascript' | 'application/javascript' {
    return contentType === 'text/javascript' || contentType === 'application/javascript';
}

export function validateInstalledEmbeddedWebBundleArtifact(params: Readonly<{
    artifact: unknown;
    expectedPluginId: string;
    expectedContributionId: string;
    hostRuntime: EmbeddedWebBundleHostRuntime;
    revokedDigests: ReadonlySet<string>;
    revocationState?: PluginUiArtifactRevocationState;
    executionTrust?: PluginUiArtifactExecutionTrust;
    signatureTrustRoots?: readonly PluginUiArtifactTrustRootV1[];
    sourceKind?: string;
}>): EmbeddedWebBundleInstallValidationResult {
    const parsed = PluginUiExecutableArtifactManifestV1Schema.safeParse(params.artifact);
    if (!parsed.success) {
        return Object.freeze({ ok: false, code: 'invalid_manifest' });
    }

    const artifact = parsed.data;
    if (artifact.contributionFamily !== 'embeddedWebBundles' || artifact.artifactKind !== 'embeddedWebBundle') {
        return Object.freeze({ ok: false, code: 'not_embedded_web_bundle' });
    }
    if (artifact.pluginId !== params.expectedPluginId) {
        return Object.freeze({ ok: false, code: 'plugin_id_mismatch' });
    }
    if (artifact.contributionId !== params.expectedContributionId) {
        return Object.freeze({ ok: false, code: 'contribution_id_mismatch' });
    }
    if (!hasPluginUiExecutableArtifactIntegrityV1(artifact)) {
        return Object.freeze({ ok: false, code: 'invalid_manifest' });
    }
    const revocationState = mergePluginUiArtifactRevocationStates(
        createPluginUiArtifactRevocationState({ revokedDigests: params.revokedDigests }),
        ...(params.revocationState ? [params.revocationState] : []),
    );
    if (isPluginUiArtifactRevoked({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        digest: artifact.integrity.digest,
        ...(artifact.integrity.signingKeyId ? { signingKeyId: artifact.integrity.signingKeyId } : {}),
        ...(artifact.installSourceId ? { installSourceId: artifact.installSourceId } : {}),
    }, revocationState)) {
        return Object.freeze({ ok: false, code: 'artifact_revoked' });
    }
    const executionTrustError = validatePluginUiArtifactExecutionTrust({
        artifact,
        executionTrust: params.executionTrust,
        signatureTrustRoots: params.signatureTrustRoots,
        revocationState,
    });
    if (executionTrustError) {
        const trust = executionTrustError === 'execution_trust_unverified'
            ? 'unverified'
            : executionTrustError;
        return Object.freeze({
            ok: false,
            code: executionTrustError,
            diagnostics: Object.freeze([
                createPluginUiArtifactTrustDiagnostic({
                    artifactKind: artifact.artifactKind,
                    sourceKind: params.sourceKind,
                    trust,
                }),
            ]),
        });
    }
    if (artifact.url || artifact.devUrl) {
        return Object.freeze({ ok: false, code: 'remote_url_unsupported' });
    }
    if (!artifact.assetPath) {
        return Object.freeze({ ok: false, code: 'installed_asset_missing' });
    }
    if (!isSupportedJavaScriptContentType(artifact.contentType)) {
        return Object.freeze({ ok: false, code: 'unsupported_content_type' });
    }
    if (!runtimeMatches(artifact, params.hostRuntime)) {
        return Object.freeze({ ok: false, code: 'runtime_mismatch' });
    }
    if (!channelSupported(artifact, params.hostRuntime, params.executionTrust)) {
        return Object.freeze({ ok: false, code: 'channel_unsupported' });
    }

    const cacheIdentity = Object.freeze({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        artifactDigest: artifact.integrity.digest,
        hostAppVersion: artifact.compatibility.hostAppVersion,
        hostUiApiVersion: artifact.compatibility.hostUiApiVersion,
        reactVersion: artifact.compatibility.reactVersion ?? '',
        platform: 'web' as const,
        channel: artifact.channel,
        projectionGeneration: params.hostRuntime.projectionGeneration,
    });

    return Object.freeze({
        ok: true,
        artifact,
        cacheKey: deriveInstalledPluginUiArtifactCacheKey(artifact),
        cacheIdentity,
    });
}
