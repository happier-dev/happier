import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import type { SessionFolderV1, SessionFoldersV1 } from '@/sync/domains/session/folders';
import {
    getServerProfileById,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import {
    buildSessionOrganizationReorderRequestFromGroupOrder,
    buildSessionOrganizationReorderRequestFromWorkspaceOrder,
} from '@/sync/domains/session/organization/viewState';

import { deleteSessionFolder } from './deleteSessionFolder';
import { deleteSessionLabel } from './deleteSessionLabel';
import { reorderSessionOrganization } from './reorderSessionOrganization';
import { setSessionFolderAssignment } from './setSessionFolderAssignment';
import { setSessionPin } from './setSessionPin';
import { setSessionTagLabels } from './setSessionTagLabels';
import { upsertSessionFolder } from './upsertSessionFolder';
import { upsertSessionLabel } from './upsertSessionLabel';

export type SessionOrganizationMutationScope = Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverIdAliases: readonly string[];
    serverUrl: string;
}>;

export type SessionOrganizationMutationScopeUnavailable = Readonly<
    | {
        ok: false;
        reason: 'serverIdRequired';
        requestedServerId: '';
    }
    | {
        ok: false;
        reason: 'serverProfileUnavailable';
        requestedServerId: string;
    }
    | {
        ok: false;
        reason: 'credentialsUnavailable';
        requestedServerId: string;
        serverId: string;
    }
>;

export type SessionOrganizationMutationScopeResult =
    | Readonly<{ ok: true; scope: SessionOrganizationMutationScope }>
    | SessionOrganizationMutationScopeUnavailable;

function normalizeId(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

function uniqueAliases(canonicalServerId: string, candidates: readonly unknown[]): string[] {
    const aliases: string[] = [];
    const seen = new Set([canonicalServerId]);
    for (const candidate of candidates) {
        const alias = normalizeId(candidate);
        if (!alias || seen.has(alias)) continue;
        seen.add(alias);
        aliases.push(alias);
    }
    return aliases;
}

export async function resolveSessionOrganizationMutationScope(
    requestedServerIdRaw: string | null | undefined,
): Promise<SessionOrganizationMutationScopeResult> {
    const requestedServerId = normalizeId(requestedServerIdRaw);
    if (!requestedServerId) {
        return {
            ok: false,
            reason: 'serverIdRequired',
            requestedServerId: '',
        };
    }

    const profile = getServerProfileById(requestedServerId);
    if (!profile) {
        return {
            ok: false,
            reason: 'serverProfileUnavailable',
            requestedServerId,
        };
    }

    const serverId = resolveServerProfileScopeId(profile);
    const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
    if (!credentials) {
        return {
            ok: false,
            reason: 'credentialsUnavailable',
            requestedServerId,
            serverId,
        };
    }

    return {
        ok: true,
        scope: {
            credentials,
            serverId,
            serverIdAliases: uniqueAliases(serverId, [
                requestedServerId,
                profile.id,
                profile.serverIdentityId,
                ...(profile.legacyServerIds ?? []),
            ]),
            serverUrl: profile.serverUrl,
        },
    };
}

function normalizeStringArray(values: readonly string[] | null | undefined): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const rawValue of values ?? []) {
        const value = normalizeId(rawValue);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        normalized.push(value);
    }
    return normalized;
}

function readSessionIdFromScopedKey(
    scope: SessionOrganizationMutationScope,
    sessionKeyRaw: unknown,
): string | null {
    const sessionKey = normalizeId(sessionKeyRaw);
    if (!sessionKey) return null;
    for (const serverId of [scope.serverId, ...scope.serverIdAliases]) {
        const prefix = `${serverId}:`;
        if (!sessionKey.startsWith(prefix)) continue;
        return normalizeId(sessionKey.slice(prefix.length)) || null;
    }
    return null;
}

export async function writeSessionOrganizationPin(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sessionId: string;
    pinned: boolean;
}>): Promise<void> {
    await setSessionPin({
        ...params.scope,
        sessionId: params.sessionId,
        pinned: params.pinned,
    });
}

export async function writeSessionOrganizationPinForSessionKey(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sessionKey: string;
    pinned: boolean;
}>): Promise<void> {
    const sessionId = readSessionIdFromScopedKey(params.scope, params.sessionKey);
    if (!sessionId) return;
    await writeSessionOrganizationPin({
        scope: params.scope,
        sessionId,
        pinned: params.pinned,
    });
}

export async function writeSessionOrganizationTagLabels(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sessionId: string;
    tags: readonly string[];
}>): Promise<void> {
    await setSessionTagLabels({
        ...params.scope,
        sessionId: params.sessionId,
        tags: normalizeStringArray(params.tags),
    });
}

export async function writeSessionOrganizationTagLabelsForSessionKey(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sessionKey: string;
    tags: readonly string[];
}>): Promise<void> {
    const sessionId = readSessionIdFromScopedKey(params.scope, params.sessionKey);
    if (!sessionId) return;
    await writeSessionOrganizationTagLabels({
        scope: params.scope,
        sessionId,
        tags: params.tags,
    });
}

export async function writeSessionOrganizationFolderAssignment(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sessionId: string;
    folderId: string | null;
}>): Promise<void> {
    await setSessionFolderAssignment({
        ...params.scope,
        sessionId: params.sessionId,
        folderId: params.folderId,
    });
}

export async function writeSessionOrganizationGroupOrder(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    next: Readonly<Record<string, readonly string[] | undefined>>;
}>): Promise<void> {
    const requests = Object.entries(params.next)
        .map(([scopeKey, itemKeys]) => buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: params.scope.serverId,
            serverIdAliases: params.scope.serverIdAliases,
            scopeKey,
            itemKeys: itemKeys ?? [],
        }))
        .filter((request): request is NonNullable<typeof request> => request != null);
    await Promise.all(requests.map((request) => reorderSessionOrganization({
        ...params.scope,
        request,
    })));
}

export async function writeSessionOrganizationWorkspaceOrder(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    next: Readonly<Record<string, readonly string[] | undefined>>;
}>): Promise<void> {
    const requests = Object.entries(params.next)
        .map(([scopeKey, itemKeys]) => buildSessionOrganizationReorderRequestFromWorkspaceOrder({
            serverId: params.scope.serverId,
            scopeKey,
            itemKeys: itemKeys ?? [],
        }))
        .filter((request): request is NonNullable<typeof request> => request != null);
    await Promise.all(requests.map((request) => reorderSessionOrganization({
        ...params.scope,
        request,
    })));
}

function buildFolderDisplay(
    folder: SessionFolderV1,
): { t: 'plain'; v: { name: string; workspace: SessionFolderV1['workspace'] } } {
    return {
        t: 'plain',
        v: {
            name: folder.name,
            workspace: folder.workspace,
        },
    };
}

function areFolderDefinitionsEqual(left: SessionFolderV1, right: SessionFolderV1): boolean {
    return left.name === right.name
        && left.parentId === right.parentId
        && (left.sortKey ?? null) === (right.sortKey ?? null)
        && JSON.stringify(left.workspace) === JSON.stringify(right.workspace);
}

export async function writeSessionOrganizationFolders(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    current: SessionFoldersV1;
    next: SessionFoldersV1;
}>): Promise<void> {
    const currentById = new Map(params.current.folders.map((folder) => [folder.id, folder]));
    const nextById = new Map(params.next.folders.map((folder) => [folder.id, folder]));
    const writes: Promise<void>[] = [];

    for (const folder of nextById.values()) {
        const current = currentById.get(folder.id);
        if (current && areFolderDefinitionsEqual(current, folder)) continue;
        writes.push(upsertSessionFolder({
            ...params.scope,
            request: {
                folderId: folder.id,
                folderKey: folder.id,
                parentFolderId: folder.parentId,
                parentFolderKey: folder.parentId,
                sortKey: folder.sortKey ?? null,
                display: buildFolderDisplay(folder),
            },
        }));
    }

    for (const folder of currentById.values()) {
        if (nextById.has(folder.id)) continue;
        writes.push(deleteSessionFolder({
            ...params.scope,
            request: {
                folderId: folder.id,
                assignmentBehavior: 'moveAssignmentsToParent',
            },
        }));
    }

    await Promise.all(writes);
}

export async function writeSessionOrganizationWorkspaceLabels(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    current: Readonly<Record<string, string>>;
    next: Readonly<Record<string, string>>;
}>): Promise<void> {
    const scopeKeys = new Set([
        ...Object.keys(params.current),
        ...Object.keys(params.next),
    ]);
    const writes: Promise<void>[] = [];

    for (const scopeKeyRaw of scopeKeys) {
        const scopeKey = normalizeId(scopeKeyRaw);
        if (!scopeKey) continue;
        const current = normalizeId(params.current[scopeKey]);
        const next = normalizeId(params.next[scopeKey]);
        if (current === next) continue;
        if (next) {
            writes.push(upsertSessionLabel({
                ...params.scope,
                request: {
                    labelKind: 'workspace',
                    scopeKey,
                    display: { t: 'plain', v: { label: next } },
                },
            }));
        } else {
            writes.push(deleteSessionLabel({
                ...params.scope,
                request: {
                    labelKind: 'workspace',
                    scopeKey,
                },
            }));
        }
    }

    await Promise.all(writes);
}
