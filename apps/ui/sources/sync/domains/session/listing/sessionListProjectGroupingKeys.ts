import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';

import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';
import { normalizeTrimmedString } from './normalizeTrimmedString';

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
    const expanded = resolveAbsolutePath(path, homeDirRaw ?? undefined);

    return normalizePathForProjectGrouping(expanded);
}

export type SessionProjectGroupingKeyParts = Readonly<{
    machineGroupId: string;
    host: string | null;
    machineId: string | null;
    homeDir: string | null;
    /** `''` for a no-folder session: its private folder is never a project. */
    pathKey: string;
    /** `managed`: the machine's no-folder sessions, which group together as its Chats. */
    bucket: 'path' | 'managed';
}>;

export type SessionProjectGroupingKeyPartsWithMachineMetadata = SessionProjectGroupingKeyParts & Readonly<{
    displayPath: string | null;
}>;

export type SessionProjectGroupingIdentity =
    | readonly [serverId: string | null, machineId: string | null, pathKey: string]
    | readonly [serverId: string | null, machineId: string | null, pathKey: '', bucket: 'managed'];

function normalizeHostForProjectGrouping(value: unknown): string | null {
    const host = normalizeNonEmptyString(value);
    return host ? host.toLowerCase().replace(/\.local$/, '') : null;
}

export function buildSessionProjectGroupingIdentity(
    serverIdInput: unknown,
    parts: Pick<SessionProjectGroupingKeyParts, 'machineId' | 'pathKey'> & Partial<Pick<SessionProjectGroupingKeyParts, 'bucket'>>,
): SessionProjectGroupingIdentity {
    const serverId = normalizeTrimmedString(serverIdInput) || null;
    // Folder identities keep their three-part shape, so existing group keys stay stable.
    return parts.bucket === 'managed'
        ? [serverId, parts.machineId, '', 'managed']
        : [serverId, parts.machineId, parts.pathKey];
}

/** Stable, reversible encoding of the exact Home/Machine/path tuple. */
export function sessionProjectGroupingIdentityKey(identity: SessionProjectGroupingIdentity): string {
    return JSON.stringify(identity);
}

type SessionProjectGroupingMetadata = Readonly<{
    host?: unknown;
    machineId?: unknown;
    path?: unknown;
    homeDir?: unknown;
    sessionDirectoryV1?: unknown;
}> | null | undefined;

export function resolveSessionProjectGroupingKeyParts(metadata: SessionProjectGroupingMetadata): SessionProjectGroupingKeyParts {
    const host = normalizeHostForProjectGrouping(metadata?.host);
    const machineId = normalizeNonEmptyString(metadata?.machineId);
    const homeDirRaw = normalizeNonEmptyString(metadata?.homeDir);
    const homeDir = homeDirRaw ? normalizePathForProjectGrouping(homeDirRaw) : null;
    const bucket = readSessionDirectoryKind(metadata) === 'managed' ? 'managed' : 'path';
    const pathKey = bucket === 'managed' ? '' : normalizeSessionPathForProjectGrouping(metadata?.path, homeDir);
    const machineGroupId = machineId ? `id:${machineId}` : 'unknown';

    return {
        machineGroupId,
        host,
        machineId,
        homeDir,
        pathKey,
        bucket,
    };
}

export function resolveSessionProjectGroupingKeyPartsWithMachineMetadata(
    metadata: SessionProjectGroupingMetadata,
    machineMetadata: Readonly<{
        host?: unknown;
        homeDir?: unknown;
    }> | null | undefined,
    displayPathInput?: unknown,
): SessionProjectGroupingKeyPartsWithMachineMetadata {
    const parts = resolveSessionProjectGroupingKeyParts(metadata);
    const host = normalizeHostForProjectGrouping(machineMetadata?.host) || parts.host;
    const homeDirRaw = normalizeTrimmedString(machineMetadata?.homeDir);
    const homeDir = homeDirRaw ? normalizePathForProjectGrouping(homeDirRaw) : parts.homeDir;
    const managed = parts.bucket === 'managed';
    const displayPath = managed ? null : normalizeTrimmedString(displayPathInput ?? metadata?.path) || null;
    const pathKey = managed ? '' : normalizeSessionPathForProjectGrouping(displayPathInput ?? metadata?.path, homeDir);
    const machineGroupId = parts.machineId ? `id:${parts.machineId}` : 'unknown';

    return {
        machineGroupId,
        host,
        machineId: parts.machineId,
        homeDir,
        pathKey,
        bucket: parts.bucket,
        displayPath,
    };
}
