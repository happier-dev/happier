import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

import type { CanonicalPluginManifest } from '@/plugins/manifest/types';

export type ResolvedManifestHostAccessRequest = Readonly<{
    request: PluginHostAccessRequestV2;
    required: boolean;
}>;

type ManifestHostAccessContributionFamily =
    | 'agents'
    | 'actions'
    | 'hooks'
    | 'resources'
    | 'backgroundServices'
    | 'notificationChannels'
    | 'connectedAccountDescriptors';

type ManifestHostAccessContributionDeclaration = Readonly<{
    id: string;
    hostAccess?: readonly string[];
}>;

type ManifestHostAccessContributionPolicy = Readonly<{
    family: ManifestHostAccessContributionFamily;
    scope: 'manifest' | 'declaration';
    readDeclarations(
        manifest: Pick<CanonicalPluginManifest, 'contributes'>,
    ): readonly ManifestHostAccessContributionDeclaration[];
}>;

/**
 * The manifest is the sole owner of how a contribution obtains HostAccess.
 * Full PluginServices contexts inherit the admitted manifest scope; target
 * contributions select the request ids their declaration names.
 */
const MANIFEST_HOST_ACCESS_CONTRIBUTION_POLICIES: readonly ManifestHostAccessContributionPolicy[] = Object.freeze([
    Object.freeze({
        family: 'agents',
        scope: 'manifest',
        readDeclarations: (manifest: Pick<CanonicalPluginManifest, 'contributes'>) => manifest.contributes.agents,
    }),
    Object.freeze({
        family: 'backgroundServices',
        scope: 'manifest',
        readDeclarations: (manifest: Pick<CanonicalPluginManifest, 'contributes'>) => manifest.contributes.backgroundServices,
    }),
    Object.freeze({
        family: 'notificationChannels',
        scope: 'manifest',
        readDeclarations: (manifest: Pick<CanonicalPluginManifest, 'contributes'>) => manifest.contributes.notificationChannels,
    }),
    Object.freeze({
        family: 'connectedAccountDescriptors',
        scope: 'manifest',
        readDeclarations: (manifest: Pick<CanonicalPluginManifest, 'contributes'>) => manifest.contributes.connectedAccountDescriptors,
    }),
    Object.freeze({
        family: 'actions',
        scope: 'declaration',
        readDeclarations: (manifest: Pick<CanonicalPluginManifest, 'contributes'>) => manifest.contributes.actions,
    }),
    Object.freeze({
        family: 'hooks',
        scope: 'declaration',
        readDeclarations: (manifest: Pick<CanonicalPluginManifest, 'contributes'>) => manifest.contributes.hooks,
    }),
    Object.freeze({
        family: 'resources',
        scope: 'declaration',
        readDeclarations: (manifest: Pick<CanonicalPluginManifest, 'contributes'>) => manifest.contributes.resources,
    }),
]);

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
        family: ManifestHostAccessContributionFamily;
        localId: string;
    }>;
    requestIds?: readonly string[];
}>): readonly ResolvedManifestHostAccessRequest[] {
    const policy = MANIFEST_HOST_ACCESS_CONTRIBUTION_POLICIES.find(
        (candidate) => candidate.family === input.contribution.family,
    );
    if (policy?.scope === 'manifest') {
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

/**
 * Resolves a live caller's HostAccess from its qualified contribution identity.
 * The returned scope comes from the current admitted manifest, not from the
 * caller's retained generation, so a current-public service cannot retain an
 * obsolete grant after publication changes.
 */
export function resolveManifestHostAccessRequestsForQualifiedContribution(input: Readonly<{
    manifest: Pick<CanonicalPluginManifest, 'hostAccess' | 'contributes'>;
    pluginId: string;
    contribution: Readonly<{
        id: string;
        qualifiedId: string;
    }>;
}>): readonly ResolvedManifestHostAccessRequest[] | null {
    const prefix = `${input.pluginId}/`;
    if (!input.contribution.qualifiedId.startsWith(prefix)) return null;
    const encodedContribution = input.contribution.qualifiedId.slice(prefix.length);
    const familyEnd = encodedContribution.indexOf('/');
    if (familyEnd <= 0) return null;
    const family = encodedContribution.slice(0, familyEnd);
    const localId = encodedContribution.slice(familyEnd + 1);
    if (!localId || localId !== input.contribution.id) return null;
    const policy = MANIFEST_HOST_ACCESS_CONTRIBUTION_POLICIES.find(
        (candidate) => candidate.family === family,
    );
    if (!policy) return null;
    const declaration = policy.readDeclarations(input.manifest).find(
        (candidate) => candidate.id === localId,
    );
    if (!declaration) return null;
    return resolveManifestHostAccessRequests({
        manifest: input.manifest,
        pluginId: input.pluginId,
        contribution: { family: policy.family, localId },
        ...(policy.scope === 'manifest'
            ? {}
            : { requestIds: declaration.hostAccess ?? [] }),
    });
}
