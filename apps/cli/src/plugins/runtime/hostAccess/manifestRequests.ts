import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

export type ResolvedManifestHostAccessRequest = Readonly<{
    request: PluginHostAccessRequestV2;
    required: boolean;
}>;

export function resolveManifestHostAccessRequests(input: Readonly<{
    manifest: Pick<CanonicalPluginManifest, 'hostAccess'>;
    pluginId: string;
    contribution: Readonly<{
        family: 'actions' | 'hooks';
        localId: string;
    }>;
    requestIds?: readonly string[];
}>): readonly ResolvedManifestHostAccessRequest[] {
    const requestIds = input.requestIds ?? [];
    return Object.freeze(requestIds.map((requestId) => {
        const requiredRequest = input.manifest.hostAccess.required.find(
            (request) => request.id === requestId,
        );
        const optionalRequest = input.manifest.hostAccess.optional.find(
            (request) => request.id === requestId,
        );
        const request = requiredRequest ?? optionalRequest;
        if (!request) {
            const contributionKind = input.contribution.family === 'actions' ? 'action' : 'hook';
            throw new Error(
                `Target ${contributionKind} '${input.pluginId}/${input.contribution.family}/${input.contribution.localId}' `
                + `references missing host access request '${requestId}'`,
            );
        }
        return Object.freeze({
            request,
            required: requiredRequest !== undefined,
        });
    }));
}
