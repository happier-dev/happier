const firstPartyPluginIdByBackendLocalId: Readonly<Record<string, string>> = Object.freeze({
    git: 'happier.scm.backend.git',
    sapling: 'happier.scm.backend.sapling',
});

const firstPartyBackendLocalIdByQualifiedId: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(
        Object.entries(firstPartyPluginIdByBackendLocalId).map(([localId, pluginId]) => [
            `${pluginId}/${localId}`,
            localId,
        ]),
    ),
);

export function getFirstPartyScmBackendQualifiedId(localId: string): string | null {
    const pluginId = firstPartyPluginIdByBackendLocalId[localId];
    return pluginId ? `${pluginId}/${localId}` : null;
}

export function getFirstPartyScmBackendLegacyLocalId(qualifiedId: string): string | null {
    return firstPartyBackendLocalIdByQualifiedId[qualifiedId] ?? null;
}

export function isFirstPartyGitScmBackendId(
    backendId: string | null | undefined,
): boolean {
    return backendId === 'git'
        || (
            typeof backendId === 'string'
            && getFirstPartyScmBackendLegacyLocalId(backendId) === 'git'
        );
}
