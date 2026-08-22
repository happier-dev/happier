import type {
    LocalServicePreviewResourceV1,
    LocalServicePreviewTargetV1,
} from '@happier-dev/protocol';
import { buildPluginHostedWebStaticAssetPreviewId } from '@happier-dev/protocol/plugins/ui';

import { HOSTED_WEB_FRAME_ANCESTOR_TOKEN_QUERY_KEY } from './staticAssets/frameAncestors';

export type HostedWebStaticAssetPreviewResourceInput = Readonly<{
    pluginId: string;
    contributionId: string;
    sessionId: string;
    machineId: string;
    endpoint: LocalServicePreviewTargetV1;
    title: string;
    /**
     * EU-8: the daemon-issued capability that lets the embedding host name
     * itself as this asset's `frame-ancestors`. It rides the access URL the app
     * already receives through the authenticated preview snapshot, so no new
     * transport is introduced for it.
     */
    frameAncestorToken?: string;
}>;

export function createHostedWebStaticAssetPreviewResource(
    input: HostedWebStaticAssetPreviewResourceInput,
): Omit<LocalServicePreviewResourceV1, 'browserTarget'> {
    const previewId = buildPluginHostedWebStaticAssetPreviewId({
        pluginId: input.pluginId,
        contributionId: input.contributionId,
        sessionId: input.sessionId,
        machineId: input.machineId,
    });
    return Object.freeze({
        previewId,
        sessionId: input.sessionId,
        machineId: input.machineId,
        owner: Object.freeze({
            kind: 'plugin' as const,
            id: input.pluginId,
        }),
        target: input.endpoint,
        initialPath: Object.freeze({
            pathname: '/',
            search: input.frameAncestorToken
                ? `?${new URLSearchParams({
                    [HOSTED_WEB_FRAME_ANCESTOR_TOKEN_QUERY_KEY]: input.frameAncestorToken,
                }).toString()}`
                : '',
        }),
        display: Object.freeze({
            title: input.title,
            addressLabel: `${input.endpoint.host}:${input.endpoint.port}`,
            iconToken: 'browser',
            tone: 'info' as const,
            diagnostics: Object.freeze({
                pluginId: input.pluginId,
                contributionId: input.contributionId,
                assetServer: 'hostedWebStaticAssets',
            }),
        }),
        originMode: 'path' as const,
    });
}
