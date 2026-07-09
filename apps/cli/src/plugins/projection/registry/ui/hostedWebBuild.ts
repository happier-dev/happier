import type { PluginHostedWebRuntimeModeV1 } from '@happier-dev/protocol/plugins/ui';

type HostedWebServiceRef =
    | Readonly<{ kind: 'staticAssets'; assetRootId: string }>
    | Readonly<{ kind: 'managedService'; serviceId: string }>
    | Readonly<{ kind: 'sessionEndpoint'; endpointIdPath: string }>;

type HostedWebContributionLike = Readonly<{
    pluginId?: string;
    definition: Readonly<{
        id: string;
        service: HostedWebServiceRef;
    }>;
}>;

type UiArtifactContributionLike = Readonly<{
    pluginId?: string;
    definition: Readonly<{
        id: string;
        contributionId: string;
        contributionFamily: string;
        artifactKind: string;
    }>;
}>;

export type HostedWebRuntimeBindingResult =
    | Readonly<{
        ok: true;
        runtimeMode: PluginHostedWebRuntimeModeV1;
        diagnostics: readonly string[];
    }>
    | Readonly<{
        ok: false;
        reason: 'hosted_web_static_artifact_missing';
        diagnostics: readonly string[];
    }>;

function findHostedWebStaticArtifact(params: Readonly<{
    contribution: HostedWebContributionLike;
    uiArtifacts: readonly UiArtifactContributionLike[];
}>): UiArtifactContributionLike | null {
    const pluginId = params.contribution.pluginId;
    return params.uiArtifacts.find((artifact) => (
        artifact.pluginId === pluginId
        && artifact.definition.contributionId === params.contribution.definition.id
        && artifact.definition.contributionFamily === 'hostedWeb'
        && artifact.definition.artifactKind === 'hostedWebAsset'
    )) ?? null;
}

export function resolveHostedWebRuntimeBinding(params: Readonly<{
    contribution: HostedWebContributionLike;
    uiArtifacts: readonly UiArtifactContributionLike[];
}>): HostedWebRuntimeBindingResult {
    const service = params.contribution.definition.service;
    if (service.kind === 'managedService') {
        return Object.freeze({
            ok: true,
            runtimeMode: Object.freeze({
                kind: 'managedLocalService',
                localServiceId: service.serviceId,
            }),
            diagnostics: Object.freeze(['lsv2_runtime_required_for_managed_service']),
        });
    }

    if (service.kind === 'sessionEndpoint') {
        return Object.freeze({
            ok: true,
            runtimeMode: Object.freeze({
                kind: 'registeredSessionEndpoint',
                endpointIdPath: service.endpointIdPath,
            }),
            diagnostics: Object.freeze(['lsv3_endpoint_projection_required']),
        });
    }

    const artifact = findHostedWebStaticArtifact(params);
    if (!artifact) {
        return Object.freeze({
            ok: false,
            reason: 'hosted_web_static_artifact_missing',
            diagnostics: Object.freeze(['hosted_web_static_artifact_missing']),
        });
    }

    return Object.freeze({
        ok: true,
        runtimeMode: Object.freeze({
            kind: 'installedStaticAssets',
            artifactId: artifact.definition.id,
            assetRootId: service.assetRootId,
        }),
        diagnostics: Object.freeze([]),
    });
}
