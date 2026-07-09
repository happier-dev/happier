import { createHash } from 'node:crypto';

import {
    hasPluginUiExecutableArtifactIntegrityV1,
    PluginUiExecutableArtifactManifestV1Schema,
    type PluginUiExecutableArtifactManifestV1,
    type PluginUiExecutableArtifactManifestWithIntegrityV1,
    type PluginUiArtifactTrustRootV1,
} from '@happier-dev/protocol';

import {
    validatePluginUiArtifactExecutionTrust,
    type PluginUiArtifactExecutionTrust,
    type PluginUiArtifactTrustedSourceReason,
} from './artifactSigning';
import { deriveInstalledPluginUiArtifactCacheKey } from './cacheKeys';
import {
    createPluginUiArtifactRevocationState,
    isPluginUiArtifactRevoked,
    type PluginUiArtifactRevocationState,
} from './revocation';

export type ReactNativeBundleHostRuntime = Readonly<{
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    platform: string;
    channel: string;
    availableNativeCapabilities: readonly string[];
    projectionGeneration: number;
}>;

export type ReactNativeBundleCacheIdentity = Readonly<{
    pluginId: string;
    contributionId: string;
    artifactDigest: string;
    hostAppVersion: string;
    hostUiApiVersion: string;
    reactVersion: string;
    reactNativeVersion: string;
    expoRuntimeVersion?: string;
    hermesVersion?: string;
    platform: string;
    channel: string;
    nativeCapabilitiesDigest: string;
    projectionGeneration: number;
}>;

export type ReactNativeBundleInstallValidationCode =
    | 'invalid_manifest'
    | 'not_react_native_bundle'
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
    | 'dev_hot_reload_not_installable'
    | 'installed_asset_missing'
    | 'hermes_bytecode_unsupported'
    | 'runtime_mismatch'
    | 'channel_unsupported'
    | 'missing_native_capability';

export type ReactNativeBundleInstallValidationResult =
    | Readonly<{
        ok: true;
        artifact: PluginUiExecutableArtifactManifestWithIntegrityV1;
        cacheKey: string;
        cacheIdentity: ReactNativeBundleCacheIdentity;
    }>
    | Readonly<{ ok: false; code: ReactNativeBundleInstallValidationCode }>;

export type ReactNativeBundleTrustedSourceReason = PluginUiArtifactTrustedSourceReason;

export type ReactNativeBundleArtifactExecutionTrust = PluginUiArtifactExecutionTrust;

export type ReactNativeBundleArtifactSourceClassification =
    | Readonly<{ kind: 'installedArtifact' }>
    | Readonly<{ kind: 'devHotReload' }>
    | Readonly<{ kind: 'remoteUnsupported' }>;

export function deriveReactNativeNativeCapabilitiesDigest(
    capabilities: readonly string[],
): string {
    const normalized = [...capabilities].map((capability) => capability.trim()).filter(Boolean).sort();
    return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

export function classifyReactNativeBundleArtifactSource(
    artifact: Readonly<Pick<PluginUiExecutableArtifactManifestV1, 'assetPath' | 'channel'> & {
        url?: string;
        devUrl?: string;
    }>,
): ReactNativeBundleArtifactSourceClassification {
    if (artifact.channel === 'development' && artifact.devUrl) {
        return Object.freeze({ kind: 'devHotReload' });
    }
    if (artifact.url) {
        return Object.freeze({ kind: 'remoteUnsupported' });
    }
    if (artifact.assetPath) {
        return Object.freeze({ kind: 'installedArtifact' });
    }
    return Object.freeze({ kind: 'remoteUnsupported' });
}

function isHermesBytecodeArtifact(artifact: PluginUiExecutableArtifactManifestV1): boolean {
    return /hermes|bytecode/iu.test(artifact.contentType)
        || /\.hbc(?:bundle)?$/iu.test(artifact.assetPath ?? '');
}

function runtimeMatches(
    artifact: PluginUiExecutableArtifactManifestV1,
    hostRuntime: ReactNativeBundleHostRuntime,
): boolean {
    const compatibility = artifact.compatibility;
    return artifact.platform === hostRuntime.platform
        && compatibility.hostAppVersion === hostRuntime.hostAppVersion
        && compatibility.hostUiApiVersion === hostRuntime.hostUiApiVersion
        && compatibility.reactVersion === hostRuntime.reactVersion
        && compatibility.reactNativeVersion === hostRuntime.reactNativeVersion
        && (compatibility.expoRuntimeVersion ?? '') === (hostRuntime.expoRuntimeVersion ?? '')
        && (compatibility.hermesVersion ?? '') === (hostRuntime.hermesVersion ?? '');
}

/**
 * RN-HARDEN item 2 — the channel compat gate's single authority.
 *
 * ROOT CAUSE this replaces: two sources of truth for "which client channel may
 * load this artifact" — the artifact's provenance `channel` field (previously
 * strict-equality-compared against the client channel inside `runtimeMatches`)
 * and the author's `supportedChannels` declaration (present in the contribution
 * schema but never consulted). The declaration is now the ONE gate input:
 * - `supportedChannels` declared → the connecting client channel must be listed.
 * - absent/empty → fail closed, EXCEPT for first-party artifacts predating the
 *   declaration, which fall back to legacy provenance-channel equality (the
 *   only remaining, deliberately-narrow use of `channel` as a gate input).
 * `channel` itself stays provenance metadata (recorded in the cache identity,
 * signature payload, and diagnostics) — never a gate input for declared artifacts.
 */
function channelSupported(
    artifact: PluginUiExecutableArtifactManifestV1,
    hostRuntime: ReactNativeBundleHostRuntime,
    executionTrust: ReactNativeBundleArtifactExecutionTrust | undefined,
): boolean {
    const declared: readonly string[] | undefined = artifact.compatibility.supportedChannels;
    if (declared && declared.length > 0) {
        return declared.includes(hostRuntime.channel);
    }
    const isFirstParty = executionTrust?.kind === 'trustedSource' && executionTrust.reason === 'first_party';
    return isFirstParty && artifact.channel === hostRuntime.channel;
}

export function validateInstalledReactNativeBundleArtifact(params: Readonly<{
    artifact: unknown;
    expectedPluginId: string;
    expectedContributionId: string;
    hostRuntime: ReactNativeBundleHostRuntime;
    revokedDigests: ReadonlySet<string>;
    revocationState?: PluginUiArtifactRevocationState;
    executionTrust?: ReactNativeBundleArtifactExecutionTrust;
    signatureTrustRoots?: readonly PluginUiArtifactTrustRootV1[];
}>): ReactNativeBundleInstallValidationResult {
    const parsed = PluginUiExecutableArtifactManifestV1Schema.safeParse(params.artifact);
    if (!parsed.success) {
        return Object.freeze({ ok: false, code: 'invalid_manifest' });
    }

    const artifact = parsed.data;
    if (artifact.contributionFamily !== 'reactNativeBundles' || artifact.artifactKind !== 'reactNativeBundle') {
        return Object.freeze({ ok: false, code: 'not_react_native_bundle' });
    }
    if (artifact.pluginId !== params.expectedPluginId) {
        return Object.freeze({ ok: false, code: 'plugin_id_mismatch' });
    }
    if (artifact.contributionId !== params.expectedContributionId) {
        return Object.freeze({ ok: false, code: 'contribution_id_mismatch' });
    }
    const source = classifyReactNativeBundleArtifactSource(artifact);
    if (source.kind !== 'installedArtifact') {
        if (source.kind === 'devHotReload') {
            return Object.freeze({ ok: false, code: 'dev_hot_reload_not_installable' });
        }
        return Object.freeze({ ok: false, code: artifact.url ? 'remote_url_unsupported' : 'installed_asset_missing' });
    }
    if (!hasPluginUiExecutableArtifactIntegrityV1(artifact)) {
        return Object.freeze({ ok: false, code: 'invalid_manifest' });
    }
    const revocationState = params.revocationState ?? createPluginUiArtifactRevocationState({
        revokedDigests: params.revokedDigests,
    });
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
        return Object.freeze({ ok: false, code: executionTrustError });
    }
    if (isHermesBytecodeArtifact(artifact)) {
        return Object.freeze({ ok: false, code: 'hermes_bytecode_unsupported' });
    }
    if (!runtimeMatches(artifact, params.hostRuntime)) {
        return Object.freeze({ ok: false, code: 'runtime_mismatch' });
    }
    if (!channelSupported(artifact, params.hostRuntime, params.executionTrust)) {
        return Object.freeze({ ok: false, code: 'channel_unsupported' });
    }

    const availableCapabilities = new Set(params.hostRuntime.availableNativeCapabilities);
    const missingCapability = artifact.compatibility.nativeCapabilities
        .some((capability) => !availableCapabilities.has(capability));
    if (missingCapability) {
        return Object.freeze({ ok: false, code: 'missing_native_capability' });
    }

    const cacheIdentity = Object.freeze({
        pluginId: artifact.pluginId,
        contributionId: artifact.contributionId,
        artifactDigest: artifact.integrity.digest,
        hostAppVersion: artifact.compatibility.hostAppVersion,
        hostUiApiVersion: artifact.compatibility.hostUiApiVersion,
        reactVersion: artifact.compatibility.reactVersion ?? '',
        reactNativeVersion: artifact.compatibility.reactNativeVersion ?? '',
        ...(artifact.compatibility.expoRuntimeVersion
            ? { expoRuntimeVersion: artifact.compatibility.expoRuntimeVersion }
            : {}),
        ...(artifact.compatibility.hermesVersion
            ? { hermesVersion: artifact.compatibility.hermesVersion }
            : {}),
        platform: artifact.platform,
        channel: artifact.channel,
        nativeCapabilitiesDigest: deriveReactNativeNativeCapabilitiesDigest(artifact.compatibility.nativeCapabilities),
        projectionGeneration: params.hostRuntime.projectionGeneration,
    });

    return Object.freeze({
        ok: true,
        artifact,
        cacheKey: deriveInstalledPluginUiArtifactCacheKey(artifact),
        cacheIdentity,
    });
}
