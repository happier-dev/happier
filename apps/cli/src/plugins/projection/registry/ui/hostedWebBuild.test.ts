import { describe, expect, it } from 'vitest';

import { resolveHostedWebRuntimeBinding } from './hostedWebBuild';

const contribution = {
    pluginId: 'acme.preview',
    definition: {
        id: 'preview-web',
        service: {
            kind: 'staticAssets',
            assetRootId: 'hosted-web/preview-web',
        },
    },
} as const;

const hostedWebArtifact = {
    pluginId: 'acme.preview',
    definition: {
        id: 'preview-web-static',
        contributionId: 'preview-web',
        contributionFamily: 'hostedWeb',
        artifactKind: 'hostedWebAsset',
        integrity: { digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
    },
} as const;

describe('hosted-web runtime projection binding', () => {
    it('binds static asset service refs to hosted-web artifact refs from the existing uiArtifacts family', () => {
        expect(resolveHostedWebRuntimeBinding({
            contribution,
            uiArtifacts: [hostedWebArtifact],
        })).toEqual({
            ok: true,
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web-static',
                assetRootId: 'hosted-web/preview-web',
            },
            diagnostics: [],
        });
    });

    it('fails closed when a static asset hosted-web contribution has no matching hosted-web artifact', () => {
        expect(resolveHostedWebRuntimeBinding({
            contribution,
            uiArtifacts: [{
                ...hostedWebArtifact,
                definition: {
                    ...hostedWebArtifact.definition,
                    contributionId: 'other-web',
                },
            }],
        })).toEqual({
            ok: false,
            reason: 'hosted_web_static_artifact_missing',
            diagnostics: ['hosted_web_static_artifact_missing'],
        });
    });

    it('projects managed-service and registered endpoint refs without starting a process or preview transport', () => {
        expect(resolveHostedWebRuntimeBinding({
            contribution: {
                ...contribution,
                definition: {
                    ...contribution.definition,
                    service: { kind: 'managedService', serviceId: 'preview-dev-server' },
                },
            },
            uiArtifacts: [hostedWebArtifact],
        })).toEqual({
            ok: true,
            runtimeMode: {
                kind: 'managedLocalService',
                localServiceId: 'preview-dev-server',
            },
            diagnostics: ['lsv2_runtime_required_for_managed_service'],
        });

        expect(resolveHostedWebRuntimeBinding({
            contribution: {
                ...contribution,
                definition: {
                    ...contribution.definition,
                    service: { kind: 'sessionEndpoint', endpointIdPath: '/preview/id' },
                },
            },
            uiArtifacts: [hostedWebArtifact],
        })).toEqual({
            ok: true,
            runtimeMode: {
                kind: 'registeredSessionEndpoint',
                endpointIdPath: '/preview/id',
            },
            diagnostics: ['lsv3_endpoint_projection_required'],
        });
    });
});
