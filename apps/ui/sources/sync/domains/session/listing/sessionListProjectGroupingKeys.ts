import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';

function normalizePathForProjectGrouping(path: string): string {
    const withForwardSlashes = path.replace(/\\/g, '/');
    const leadingUncSlashes = withForwardSlashes.match(/^\/{2,}/)?.[0].length ?? 0;
    const uncPrefix = leadingUncSlashes >= 2 ? '//' : '';
    const rest = uncPrefix ? withForwardSlashes.slice(leadingUncSlashes) : withForwardSlashes;
    const normalized = uncPrefix + rest.replace(/\/+/g, '/');
    if (/^[a-zA-Z]:\/$/.test(normalized)) return normalized;
    if (normalized.length > 1 && normalized.endsWith('/')) return normalized.slice(0, -1);
    return normalized;
}

export function normalizeSessionPathForProjectGrouping(pathInput: unknown, homeDirInput: unknown): string {
    const path = normalizeNonEmptyString(pathInput);
    if (!path) return '';

    const homeDirRaw = normalizeNonEmptyString(homeDirInput);
    const homeDir = homeDirRaw ? normalizePathForProjectGrouping(homeDirRaw) : null;
    let expanded = path;
    if (homeDir && path.startsWith('~')) {
        if (path === '~') {
            expanded = homeDir;
        } else if (path.startsWith('~/') || path.startsWith('~\\')) {
            expanded = `${homeDir}/${path.slice(2)}`;
        }
    }

    return normalizePathForProjectGrouping(expanded);
}

export type SessionProjectGroupingKeyParts = Readonly<{
    machineGroupId: string;
    host: string | null;
    machineId: string | null;
    homeDir: string | null;
    pathKey: string;
}>;

export function resolveSessionProjectGroupingKeyParts(metadata: Readonly<{
    host?: unknown;
    machineId?: unknown;
    path?: unknown;
    homeDir?: unknown;
}> | null | undefined): SessionProjectGroupingKeyParts {
    const host = normalizeNonEmptyString(metadata?.host);
    const machineId = normalizeNonEmptyString(metadata?.machineId);
    const homeDirRaw = normalizeNonEmptyString(metadata?.homeDir);
    const homeDir = homeDirRaw ? normalizePathForProjectGrouping(homeDirRaw) : null;
    const pathKey = normalizeSessionPathForProjectGrouping(metadata?.path, homeDir);
    const machineGroupId = host ? `host:${host}` : machineId ? `id:${machineId}` : 'unknown';

    return {
        machineGroupId,
        host,
        machineId,
        homeDir,
        pathKey,
    };
}
