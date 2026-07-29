import {
    type WorkspaceRefV1,
} from '@happier-dev/protocol';

function normalizeIdentifier(value: string): string {
    return value.trim();
}

function normalizeWorkspaceRootPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) return '';

    const slashNormalized = trimmed.replace(/\\/g, '/');
    const isUncPath = slashNormalized.startsWith('//');
    const collapsed = slashNormalized.replace(/\/+/g, '/');
    const withUncPrefix = isUncPath ? `/${collapsed}` : collapsed;
    const withoutTrailingSlash = withUncPrefix.length > 1
        ? withUncPrefix.replace(/\/+$/g, '')
        : withUncPrefix;
    return /^[a-zA-Z]:\//.test(withoutTrailingSlash) || withoutTrailingSlash.startsWith('//')
        ? withoutTrailingSlash.toLowerCase()
        : withoutTrailingSlash;
}

export function resolveWorkspaceRefForMachineRoot(
    workspaceRefs: readonly WorkspaceRefV1[],
    scope: Readonly<{ machineId: string; rootPath: string }>,
): WorkspaceRefV1 | null {
    const machineId = normalizeIdentifier(scope.machineId);
    const rootPath = normalizeWorkspaceRootPath(scope.rootPath);
    if (!machineId || !rootPath) return null;
    const matches = workspaceRefs.filter((ref) => (
        normalizeIdentifier(ref.machineId) === machineId
        && normalizeWorkspaceRootPath(ref.rootPath) === rootPath
    ));
    return matches.length === 1 ? matches[0] ?? null : null;
}
