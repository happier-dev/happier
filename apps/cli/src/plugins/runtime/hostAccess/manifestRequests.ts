import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

export type ResolvedManifestHostAccessRequest = Readonly<{
    request: PluginHostAccessRequestV2;
    required: boolean;
}>;

/**
 * Static daemon consumers may only project declarations that are required by
 * the admitted manifest. Optional HostAccess remains invocation-scoped so a
 * consumer cannot turn an omitted selection into an ambient grant.
 */
export function projectRequiredManifestEnvironmentNames(
    manifest: Pick<CanonicalPluginManifest, 'hostAccess'>,
): readonly string[] {
    const names = new Set<string>();
    for (const request of manifest.hostAccess.required) {
        if (request.capability === 'environment') {
            for (const key of request.scope.keys) names.add(key);
        }
        if (request.capability === 'process') {
            for (const key of request.scope.envKeys ?? []) names.add(key);
        }
    }
    return Object.freeze([...names].sort());
}

/**
 * External-session observation accepts only workspace-relative paths. Other
 * filesystem roots remain available solely through the normal invocation
 * binding that owns their root resolution and operation checks.
 */
export function projectRequiredManifestWorkspaceFilesystemReadPaths(
    manifest: Pick<CanonicalPluginManifest, 'hostAccess'>,
): readonly string[] {
    const paths = new Set<string>();
    for (const request of manifest.hostAccess.required) {
        if (
            request.capability !== 'filesystem'
            || !request.scope.access.includes('read')
        ) continue;
        for (const location of request.scope.locations) {
            if (location.root === 'workspace') paths.add(location.pathPrefix ?? '');
        }
    }
    return Object.freeze([...paths].sort());
}

export function resolveManifestHostAccessRequests(input: Readonly<{
    manifest: Pick<CanonicalPluginManifest, 'hostAccess'>;
    pluginId: string;
    contribution: Readonly<{
        family: 'actions' | 'hooks' | 'resources' | 'backgroundServices';
        localId: string;
    }>;
    requestIds?: readonly string[];
}>): readonly ResolvedManifestHostAccessRequest[] {
    if (input.contribution.family === 'backgroundServices') {
        return Object.freeze([
            ...input.manifest.hostAccess.required.map((request) => Object.freeze({ request, required: true })),
            ...input.manifest.hostAccess.optional.map((request) => Object.freeze({ request, required: false })),
        ]);
    }
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
            const contributionKind = input.contribution.family === 'actions'
                ? 'action'
                : input.contribution.family === 'hooks'
                    ? 'hook'
                    : 'resource';
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
