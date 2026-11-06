import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import type { SetSessionPinRequest, SetSessionPinResponse } from '@happier-dev/protocol/sessions/organization/mutations';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { HappyError } from '@/utils/errors/errors';
import { parseToken } from '@/utils/auth/parseToken';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
    areSessionFolderDefinitionsEqual,
    type SessionFolderV1,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders/types';
import {
    getServerProfileById,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import {
    buildSessionOrganizationReorderRequestFromGroupOrder,
    buildSessionOrganizationReorderRequestFromWorkspaceOrder,
    type SessionOrganizationOrderItemAddress,
} from '@/sync/domains/session/organization/viewState';

import { deleteSessionFolder } from './deleteSessionFolder';
import { deleteSessionLabel } from './deleteSessionLabel';
import { reorderSessionOrganization } from './reorderSessionOrganization';
import { sessionOrganizationActions } from './sessionOrganizationActions';
import { setSessionPin } from './setSessionPin';
import { setSessionAppearance } from './setSessionAppearance';
import { areSessionAppearanceColorsEqual, parseSessionAppearanceColor, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { buildSessionOrganizationLabelKey } from '@/sync/domains/session/organization/keys';
import { readSessionOrganizationDisplayRecord } from '@/sync/domains/session/organization/displayRecord';
import { setSessionTagLabels } from './setSessionTagLabels';
import { upsertSessionFolder } from './upsertSessionFolder';
import { upsertSessionLabel } from './upsertSessionLabel';

export type SessionOrganizationMutationScope = Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverIdAliases: readonly string[];
    serverUrl: string;
    requestAtEndpoint?: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent?: () => void;
}>;

/** Project the Action's existing Account binding; never select credentials a second time. */
export function createSessionOrganizationMutationScopeForAccount(account: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent: () => void;
}>): SessionOrganizationMutationScope {
    account.assertCurrent();
    const profile = getServerProfileById(account.serverId);
    if (!profile) throw new Error('action_home_not_found');
    return {
        credentials: account.credentials,
        serverId: account.serverId,
        serverIdAliases: uniqueAliases(account.serverId, [profile.id, profile.serverIdentityId, ...(profile.legacyServerIds ?? [])]),
        serverUrl: profile.serverUrl,
        requestAtEndpoint: account.request,
        assertCurrent: account.assertCurrent,
    };
}

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

export async function writeSessionOrganizationPin(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sessionId: string;
    pinned: boolean;
    surface?: SetSessionPinRequest['surface'];
    sortKey?: string | null;
}>): Promise<SetSessionPinResponse> {
    params.scope.assertCurrent?.();
    if (params.surface === 'rail' && params.pinned) {
        const row = readSessionListRowForServerId(getStorage().getState().sessionListRowsByServerId,
            params.scope.serverId, params.sessionId);
        if (readSessionBotV1(row?.metadata?.bot)?.kind !== 'bot') {
            throw new HappyError('session_not_bot', false, { code: 'session_not_bot' });
        }
    }
    return await setSessionPin({
        ...params.scope,
        sessionId: params.sessionId,
        pinned: params.pinned,
        surface: params.surface,
        sortKey: params.sortKey,
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

export async function writeSessionOrganizationFolderAssignment(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sessionId: string;
    folderId: string | null;
}>): Promise<void> {
    params.scope.assertCurrent?.();
    const result = await sessionOrganizationActions.setSection(params.sessionId, params.folderId, {
        serverId: params.scope.serverId,
        expectedAccountId: parseToken(params.scope.credentials.token),
    });
    params.scope.assertCurrent?.();
    requireActionSuccess(result);
}

/** Creates, edits or removes a section definition on the scope's captured Home and Account. */
export async function writeSessionSectionDefinition(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    actionId: 'session.sections.create' | 'session.sections.update' | 'session.sections.delete';
    input: Readonly<Record<string, unknown>>;
}>): Promise<unknown> {
    params.scope.assertCurrent?.();
    const result = await sessionOrganizationActions.editSection(params.actionId, params.input, {
        serverId: params.scope.serverId,
        expectedAccountId: parseToken(params.scope.credentials.token),
    });
    params.scope.assertCurrent?.();
    requireActionSuccess(result);
    return result.result;
}

/** Archives every Session filed in the section, on the scope's captured Home and Account; returns the per-member result. */
export async function archiveSessionSection(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sectionId: string;
}>): Promise<unknown> {
    params.scope.assertCurrent?.();
    const result = await sessionOrganizationActions.archiveSection(params.sectionId, {
        serverId: params.scope.serverId,
        expectedAccountId: parseToken(params.scope.credentials.token),
    });
    params.scope.assertCurrent?.();
    requireActionSuccess(result);
    return result.result;
}

export async function writeSessionOrganizationGroupOrder(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    next: Readonly<Record<string, readonly string[] | undefined>>;
    /** Exact owner for every list item key; keys it does not resolve never reach this Home. */
    orderItemAddressByItemKey?: Readonly<Record<string, SessionOrganizationOrderItemAddress>>;
}>): Promise<void> {
    const requests = Object.entries(params.next)
        .map(([scopeKey, itemKeys]) => buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: params.scope.serverId,
            serverIdAliases: params.scope.serverIdAliases,
            scopeKey,
            itemKeys: itemKeys ?? [],
            orderItemAddressByItemKey: params.orderItemAddressByItemKey,
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

export async function writeSessionOrganizationFolders(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    current: SessionFoldersV1;
    next: SessionFoldersV1;
}>): Promise<void> {
    const currentById = new Map(params.current.folders.map((folder) => [folder.id, folder]));
    const nextById = new Map(params.next.folders.map((folder) => [folder.id, folder]));
    const writes: Promise<unknown>[] = [];

    for (const folder of nextById.values()) {
        const current = currentById.get(folder.id);
        if (current && areSessionFolderDefinitionsEqual(current, folder)) continue;
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

export async function writeSessionOrganizationAppearance(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    sessionId: string;
    color: SessionAppearanceColor | null;
}>): Promise<void> {
    params.scope.assertCurrent?.();
    await setSessionAppearance({ ...params.scope, sessionId: params.sessionId, color: params.color });
    params.scope.assertCurrent?.();
}

const pendingWorkspaceDisplayWrites = new Map<string, Promise<void>>();

/** Serializes name/colour intents at their shared display row, preserving all other fields. */
export async function writeSessionOrganizationWorkspaceDisplay(params: Readonly<{
    scope: SessionOrganizationMutationScope;
    workspaceKey: string;
    patch: Readonly<{ label?: string | null; color?: SessionAppearanceColor | null }>;
}>): Promise<void> {
    const scopeKey = normalizeId(params.workspaceKey);
    if (!scopeKey) return;
    const key = buildSessionOrganizationLabelKey({ serverId: params.scope.serverId, labelKind: 'workspace', scopeKey });
    const previous = pendingWorkspaceDisplayWrites.get(key);
    const write = (async () => {
        if (previous) await previous.catch(() => undefined);
        params.scope.assertCurrent?.();
        const row = getStorage().getState().sessionOrganizationLabelsByLabelKey[key];
        const current = row?.archivedAt == null ? row : undefined;
        if (current && current.displayState.status !== 'available') throw new HappyError('workspace_display_unavailable', false);
        const record = current ? readSessionOrganizationDisplayRecord(current.displayState, current.display) : {};
        if (!record) throw new HappyError('workspace_display_unavailable', false);
        const currentLabel = normalizeId(record.label);
        const currentColor = parseSessionAppearanceColor(record.color);
        const label = params.patch.label === undefined ? currentLabel : normalizeId(params.patch.label);
        const color = params.patch.color === undefined ? currentColor : parseSessionAppearanceColor(params.patch.color);
        if (label === currentLabel && areSessionAppearanceColorsEqual(color, currentColor)) return;
        if (!label && !color) {
            await deleteSessionLabel({ ...params.scope, request: { labelKind: 'workspace', scopeKey } });
        } else {
            const next = { ...record };
            delete next.label;
            delete next.color;
            await upsertSessionLabel({ ...params.scope, request: { labelKind: 'workspace', scopeKey,
                display: { t: 'plain', v: { ...next, ...(label ? { label } : {}), ...(color ? { color } : {}) } } } });
        }
        params.scope.assertCurrent?.();
    })();
    pendingWorkspaceDisplayWrites.set(key, write);
    try { await write; } finally {
        if (pendingWorkspaceDisplayWrites.get(key) === write) pendingWorkspaceDisplayWrites.delete(key);
    }
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
        writes.push(writeSessionOrganizationWorkspaceDisplay({ scope: params.scope, workspaceKey: scopeKey, patch: { label: next || null } }));
    }

    await Promise.all(writes);
}
