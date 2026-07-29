import type {
    LocalServicePreviewInitialPathV1,
    LocalServicePreviewResourceV1,
    LocalServicePreviewTargetV1,
} from '@happier-dev/protocol';
import { buildPluginHostedWebStaticAssetPreviewId } from '@happier-dev/protocol/plugins/ui';

export type HostedWebStaticAssetPreviewResourceInput = Readonly<{
    pluginId: string;
    contributionId: string;
    sessionId: string;
    machineId: string;
    endpoint: LocalServicePreviewTargetV1;
    title: string;
}>;

export type HostedWebManagedLocalServicePreviewResourceInput = Readonly<{
    pluginId: string;
    contributionId: string;
    serviceId: string;
    sessionId: string;
    machineId: string;
    endpoint: LocalServicePreviewTargetV1;
    title: string;
    initialPath?: LocalServicePreviewInitialPathV1;
}>;

function sanitizePreviewIdPart(value: string): string {
    return value.trim().replace(/[^a-zA-Z0-9._:-]+/gu, '-');
}

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
            search: '',
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

export function createHostedWebManagedLocalServicePreviewResource(
    input: HostedWebManagedLocalServicePreviewResourceInput,
): Omit<LocalServicePreviewResourceV1, 'browserTarget'> {
    const previewId = [
        'plugin-managed',
        sanitizePreviewIdPart(input.pluginId),
        sanitizePreviewIdPart(input.contributionId),
        sanitizePreviewIdPart(input.serviceId),
    ].join(':');
    return Object.freeze({
        previewId,
        sessionId: input.sessionId,
        machineId: input.machineId,
        owner: Object.freeze({
            kind: 'plugin' as const,
            id: input.pluginId,
        }),
        target: input.endpoint,
        initialPath: Object.freeze(input.initialPath ?? {
            pathname: '/',
            search: '',
        }),
        display: Object.freeze({
            title: input.title,
            addressLabel: `${input.endpoint.host}:${input.endpoint.port}`,
            iconToken: 'browser',
            tone: 'info' as const,
            diagnostics: Object.freeze({
                pluginId: input.pluginId,
                contributionId: input.contributionId,
                serviceId: input.serviceId,
                serviceKind: 'managedLocalService',
            }),
        }),
        originMode: 'path' as const,
    });
}
