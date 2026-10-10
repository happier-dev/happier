// Imported from the folder type owner rather than the domain barrel: this projection is loaded by
// list, search and mutation paths that must not pull the whole folder/tree runtime with them.
import {
    areSessionFolderDefinitionsEqual,
    type SessionFolderList,
    type SessionFolderV1,
    type SessionFolderWorkspaceRefV1,
    type SessionFoldersV1,
} from '@/sync/domains/session/folders/types';
import {
    buildSessionListFolderOrderItemKey,
    PINNED_GROUP_KEY_V1,
} from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import {
    buildSessionWorkspaceOrderItemKey,
    buildSessionWorkspaceOrderScopeKey,
    readSessionWorkspaceOrderScopeServerId,
    type SessionWorkspaceOrderV1,
} from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import type { ReorderSessionOrganizationRequest } from '@happier-dev/protocol';
import type { SessionAttentionStanding } from '@happier-dev/protocol';
import { sessionAddressKey } from '../sessionAddress';

import type {
    SessionOrganizationDisplayState,
    SessionOrganizationProjection,
} from './types';
import { sessionFolderAddressKey } from '../folders/assignmentKeys';
import { buildSessionOrganizationTagLabelById } from './tagLabels';

type HumanDisplayState =
    | Readonly<{ status: 'available'; value: string }>
    | Extract<SessionOrganizationDisplayState, { status: 'locked' }>;

export type SessionOrganizationListTag = Readonly<{
    tagId: string;
    display: HumanDisplayState;
}>;

/**
 * Exact owning Home and Home-local identity behind one list order item key. List keys are
 * opaque composites, so every write resolves them through this projection instead of
 * parsing them: two Homes can hold the same Home-local Session or folder id, and a key
 * this projection never minted belongs to no Home at all.
 */
export type SessionOrganizationOrderItemAddress =
    | Readonly<{ itemKind: 'session'; serverId: string; sessionId: string }>
    | Readonly<{ itemKind: 'folder'; serverId: string; folderId: string }>;

export type SessionOrganizationListViewState = Readonly<{
    pinnedSessionKeysV1: readonly string[];
    sessionFoldersV1: SessionFolderList;
    sessionFolderAssignmentsBySessionKey: Record<string, string | null>;
    sessionTagsV1: Record<string, readonly SessionOrganizationListTag[]>;
    /**
     * Per-session standing overrides, keyed the way every other session-keyed slice here is, so a
     * surface can join them with the account default without a second projection subscription.
     * A `false` entry is a real "removed from Needs attention", never an absent key.
     */
    attentionStandingOverridesBySessionKey: Record<string, SessionAttentionStanding>;
    sessionListGroupOrderV1: Record<string, readonly string[]>;
    sessionWorkspaceOrderV1: SessionWorkspaceOrderV1;
    workspaceLabelsV1: Record<string, HumanDisplayState>;
    folderDisplayStatesByFolderKey: Record<string, HumanDisplayState>;
    labelDisplayStatesByKey: Record<string, HumanDisplayState>;
    sessionTagDisplayStatesBySessionKey: Record<
        string,
        readonly Readonly<{
            tagId: string;
            display: HumanDisplayState;
        }>[]
    >;
    /**
     * Exact owner for every order item key this projection mints, whether or not the current
     * viewport renders it. The reorder write path resolves keys here so a per-Home writer can
     * never receive another Home's Session or folder id.
     */
    orderItemAddressByItemKey: Record<string, SessionOrganizationOrderItemAddress>;
}>;

function buildServerSessionKey(serverId: string, sessionId: string): string {
    return sessionAddressKey({ serverId: serverId.trim(), sessionId: String(sessionId ?? '').trim() });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPlainDisplayRecord(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value) || value.t !== 'plain' || !isRecord(value.v)) return null;
    return value.v;
}

function readDisplayRecord(
    displayState: SessionOrganizationDisplayState,
    display: unknown,
): Record<string, unknown> | null {
    if (displayState.status !== 'available') return null;
    return isRecord(displayState.value)
        ? displayState.value
        : readPlainDisplayRecord(display);
}

function readFolderName(
    displayState: SessionOrganizationDisplayState,
    display: unknown,
): string | null {
    const record = readDisplayRecord(displayState, display);
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    return name || null;
}

function readLabel(
    displayState: SessionOrganizationDisplayState,
    display: unknown,
): string | null {
    const record = readDisplayRecord(displayState, display);
    const label = typeof record?.label === 'string' ? record.label.trim() : '';
    return label || null;
}

function readWorkspaceRef(
    displayState: SessionOrganizationDisplayState,
    display: unknown,
): SessionFolderWorkspaceRefV1 | null {
    const record = readDisplayRecord(displayState, display);
    const workspace = record?.workspace;
    if (!isRecord(workspace)) return null;
    if (workspace.t !== 'workspaceScope') return null;
    const serverId = typeof workspace.serverId === 'string' ? workspace.serverId.trim() : '';
    const machineId = typeof workspace.machineId === 'string' ? workspace.machineId.trim() : '';
    const rootPath = typeof workspace.rootPath === 'string' ? workspace.rootPath.trim() : '';
    if (!serverId || !machineId || !rootPath) return null;
    return { t: 'workspaceScope', serverId, machineId, rootPath };
}

function compareBySortKey(a: { sortKey?: string | null }, b: { sortKey?: string | null }): number {
    const left = typeof a.sortKey === 'string' ? a.sortKey : '';
    const right = typeof b.sortKey === 'string' ? b.sortKey : '';
    if (left && right && left !== right) return left.localeCompare(right);
    if (left) return -1;
    if (right) return 1;
    return 0;
}

function normalizeWorkspaceItemKey(itemKey: string): string | null {
    return buildSessionWorkspaceOrderItemKey(itemKey);
}

function normalizeWorkspaceScopeKey(serverId: string, scopeKey: string): string {
    const trimmed = scopeKey.trim();
    return buildSessionWorkspaceOrderScopeKey(trimmed || serverId);
}

function appendOrderedValue(map: Record<string, string[]>, scopeKey: string, itemKey: string): void {
    const bucket = map[scopeKey] ?? [];
    if (!bucket.includes(itemKey)) {
        bucket.push(itemKey);
    }
    map[scopeKey] = bucket;
}

function buildSortKey(index: number): string {
    return String(index + 1).padStart(8, '0');
}

function stripServerSessionKey(serverId: string, itemKeyRaw: string, serverIdAliases?: readonly string[] | null): string | null {
    const itemKey = itemKeyRaw.trim();
    if (!itemKey) return null;
    const allowedServerIds = [serverId, ...(serverIdAliases ?? [])]
        .map((id) => id.trim())
        .filter(Boolean);
    for (const allowedServerId of allowedServerIds) {
        const prefix = `${allowedServerId}:`;
        if (itemKey.startsWith(prefix)) return itemKey.slice(prefix.length).trim() || null;
    }
    return itemKey.includes(':') ? null : itemKey;
}

function stripFolderItemKey(itemKeyRaw: string): string | null {
    const itemKey = itemKeyRaw.trim();
    if (!itemKey) return null;
    return itemKey.startsWith('folder:') ? itemKey.slice('folder:'.length).trim() || null : itemKey;
}

function stripWorkspaceItemKey(itemKeyRaw: string): string | null {
    const itemKey = itemKeyRaw.trim();
    if (!itemKey) return null;
    return itemKey.startsWith('workspace:') ? itemKey.slice('workspace:'.length).trim() || null : itemKey;
}

type ResolvedOrderItem = Readonly<{ itemKind: 'session' | 'folder'; itemKey: string }>;

function buildAllowedServerIdSet(
    serverId: string,
    serverIdAliases?: readonly string[] | null,
): ReadonlySet<string> {
    return new Set([serverId, ...(serverIdAliases ?? [])]
        .map((id) => id.trim())
        .filter(Boolean));
}

function resolveCanonicalOrderItem(
    address: SessionOrganizationOrderItemAddress | undefined,
    allowedServerIds: ReadonlySet<string>,
): ResolvedOrderItem | null {
    if (!address || !allowedServerIds.has(address.serverId.trim())) return null;
    const itemKey = address.itemKind === 'session'
        ? address.sessionId.trim()
        : address.folderId.trim();
    return itemKey ? { itemKind: address.itemKind, itemKey } : null;
}

function resolveLegacyServerScopedOrderItem(
    serverId: string,
    serverIdAliases: readonly string[] | undefined,
    itemKey: string,
): ResolvedOrderItem | null {
    if (itemKey.startsWith('folder:')) {
        const folderId = stripFolderItemKey(itemKey);
        return folderId ? { itemKind: 'folder', itemKey: folderId } : null;
    }
    const sessionId = stripServerSessionKey(serverId, itemKey, serverIdAliases);
    return sessionId ? { itemKind: 'session', itemKey: sessionId } : null;
}

export function buildSessionOrganizationReorderRequestFromGroupOrder(params: Readonly<{
    serverId: string;
    serverIdAliases?: readonly string[];
    scopeKey: string;
    itemKeys: readonly string[];
    /**
     * Exact owner and identity for every canonical list item key. Live surfaces always pass
     * it, and an item key it does not resolve — another Home's row, or a key this projection
     * never minted — is dropped instead of being sent to this Home as an opaque id.
     */
    orderItemAddressByItemKey?: Readonly<Record<string, SessionOrganizationOrderItemAddress>>;
    /**
     * Released legacy import only: item keys are `${serverId}:${sessionId}` or `folder:<id>`
     * strings already scoped to one Home by the importer.
     */
    legacyServerScopedItemKeys?: boolean;
}>): ReorderSessionOrganizationRequest | null {
    const serverId = params.serverId.trim();
    const legacyScopeKey = params.scopeKey.trim();
    if (!serverId || !legacyScopeKey) return null;
    const scopeKind = legacyScopeKey === PINNED_GROUP_KEY_V1 ? 'pinned' : 'group';
    const scopeKey = scopeKind === 'pinned' ? 'pins' : legacyScopeKey;
    const allowedServerIds = buildAllowedServerIdSet(serverId, params.serverIdAliases);
    const entries: ReorderSessionOrganizationRequest['entries'] = [];
    const seen = new Set<string>();
    for (const rawItemKey of params.itemKeys) {
        const trimmed = typeof rawItemKey === 'string' ? rawItemKey.trim() : '';
        if (!trimmed) continue;
        const resolved = params.legacyServerScopedItemKeys === true
            ? resolveLegacyServerScopedOrderItem(serverId, params.serverIdAliases, trimmed)
            : resolveCanonicalOrderItem(params.orderItemAddressByItemKey?.[trimmed], allowedServerIds);
        if (!resolved) continue;
        const dedupeKey = JSON.stringify([resolved.itemKind, resolved.itemKey]);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
            itemKind: resolved.itemKind,
            itemKey: resolved.itemKey,
            sortKey: buildSortKey(entries.length),
        });
    }
    return { scopeKind, scopeKey, entries };
}

export function buildSessionOrganizationReorderRequestFromWorkspaceOrder(params: Readonly<{
    serverId: string;
    serverIdAliases?: readonly string[];
    scopeKey: string;
    itemKeys: readonly string[];
    /**
     * Released legacy import only: the scope key is the `server:<serverId>:workspaces` shape
     * persisted in legacy Account settings, already narrowed to this Home by the importer.
     */
    legacyServerScopedScopeKey?: boolean;
}>): ReorderSessionOrganizationRequest | null {
    const serverId = params.serverId.trim();
    const legacyScopeKey = params.scopeKey.trim();
    if (!serverId || !legacyScopeKey) return null;
    const allowedServerIds = buildAllowedServerIdSet(serverId, params.serverIdAliases);
    // A canonical workspace order scope names its own Home. Another Home's scope is never
    // this Home's to rewrite, so it is refused rather than persisted under a foreign key.
    const scopeServerId = readSessionWorkspaceOrderScopeServerId(legacyScopeKey);
    if (scopeServerId && !allowedServerIds.has(scopeServerId)) return null;
    const scopeKey = scopeServerId || params.legacyServerScopedScopeKey === true
        ? serverId
        : legacyScopeKey;
    const entries: ReorderSessionOrganizationRequest['entries'] = [];
    const seen = new Set<string>();
    for (const rawItemKey of params.itemKeys) {
        const raw = typeof rawItemKey === 'string' ? rawItemKey : '';
        const itemKey = params.legacyServerScopedScopeKey === true
            ? stripWorkspaceItemKey(raw)
            : buildSessionWorkspaceOrderItemKey(raw);
        if (!itemKey || seen.has(itemKey)) continue;
        seen.add(itemKey);
        entries.push({
            itemKind: 'workspace',
            itemKey,
            sortKey: buildSortKey(entries.length),
        });
    }
    return { scopeKind: 'workspace', scopeKey, entries };
}

/**
 * Splits a merged multi-Home group order into one request map per exact owning Home. An item
 * key with no published address belongs to no mounted Home and is dropped, so no Home is
 * asked to persist another Home's Session or folder id.
 */
export function partitionSessionOrganizationGroupOrderByServerId(params: Readonly<{
    next: Readonly<Record<string, readonly string[] | undefined>>;
    orderItemAddressByItemKey: Readonly<Record<string, SessionOrganizationOrderItemAddress>>;
}>): Record<string, Record<string, string[]>> {
    const byServerId: Record<string, Record<string, string[]>> = {};
    for (const [rawScopeKey, itemKeys] of Object.entries(params.next)) {
        const scopeKey = rawScopeKey.trim();
        if (!scopeKey) continue;
        for (const rawItemKey of itemKeys ?? []) {
            const itemKey = typeof rawItemKey === 'string' ? rawItemKey.trim() : '';
            if (!itemKey) continue;
            const serverId = params.orderItemAddressByItemKey[itemKey]?.serverId.trim();
            if (!serverId) continue;
            const scopes = byServerId[serverId] ?? (byServerId[serverId] = {});
            (scopes[scopeKey] ?? (scopes[scopeKey] = [])).push(itemKey);
        }
    }
    return byServerId;
}

/**
 * Splits a merged multi-Home workspace order by the Home each scope key names. A released
 * legacy scope key names no Home of its own and stays with `fallbackServerId`, preserving
 * the incumbent single-Home behavior for imported orders.
 */
export function partitionSessionWorkspaceOrderByServerId(params: Readonly<{
    next: Readonly<Record<string, readonly string[] | undefined>>;
    fallbackServerId?: string;
}>): Record<string, Record<string, string[]>> {
    const byServerId: Record<string, Record<string, string[]>> = {};
    for (const [rawScopeKey, itemKeys] of Object.entries(params.next)) {
        const scopeKey = rawScopeKey.trim();
        if (!scopeKey) continue;
        const serverId = readSessionWorkspaceOrderScopeServerId(scopeKey)
            ?? (params.fallbackServerId ?? '').trim();
        if (!serverId) continue;
        const keys = (itemKeys ?? [])
            .map((itemKey) => (typeof itemKey === 'string' ? itemKey.trim() : ''))
            .filter(Boolean);
        if (keys.length === 0) continue;
        const scopes = byServerId[serverId] ?? (byServerId[serverId] = {});
        scopes[scopeKey] = [...(scopes[scopeKey] ?? []), ...keys];
    }
    return byServerId;
}

/**
 * Completes the published order-item addresses with the Homes' canonical corpus membership.
 *
 * The organization projection can only address Sessions that already own an organization record.
 * A Session that was never pinned, tagged, foldered or manually ordered is still a member of its
 * Home's corpus and can still be dragged, so its exact owner is published here rather than being
 * recovered by parsing an opaque key. Returns the same projection when it already addresses every
 * member, so an unchanged corpus keeps the callback identities that depend on it.
 */
export function completeSessionOrganizationOrderItemAddresses(params: Readonly<{
    orderItemAddressByItemKey: Readonly<Record<string, SessionOrganizationOrderItemAddress>>;
    memberHomes: readonly Readonly<{ serverId: string; sessionIds: readonly string[] }>[];
}>): Readonly<Record<string, SessionOrganizationOrderItemAddress>> {
    let completed: Record<string, SessionOrganizationOrderItemAddress> | null = null;
    for (const home of params.memberHomes) {
        const serverId = home.serverId.trim();
        if (!serverId) continue;
        for (const rawSessionId of home.sessionIds) {
            const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
            if (!sessionId) continue;
            const itemKey = sessionAddressKey({ serverId, sessionId });
            if (params.orderItemAddressByItemKey[itemKey] || completed?.[itemKey]) continue;
            completed = completed ?? { ...params.orderItemAddressByItemKey };
            completed[itemKey] = { itemKind: 'session', serverId, sessionId };
        }
    }
    return completed ?? params.orderItemAddressByItemKey;
}

/**
 * Splits one merged multi-Home folder tree into the exact per-Home writes it represents.
 *
 * The tree a person edits contains every selected Home's folders at once. Sending that merged
 * tree to the focused Home would recreate another Home's folder there, delete a same-id folder
 * that Home happens to own, and leave the folder actually edited untouched. Each folder's own
 * workspace names its Home; the published folder addresses confirm that Home really stores it,
 * and only a folder that names no Home at all falls back to the Home the surface is acting on.
 */
export function partitionSessionFolderWritesByServerId(params: Readonly<{
    current: SessionFoldersV1;
    next: SessionFoldersV1;
    orderItemAddressByItemKey: Readonly<Record<string, SessionOrganizationOrderItemAddress>>;
    fallbackServerId: string;
}>): Record<string, Readonly<{ current: SessionFoldersV1; next: SessionFoldersV1 }>> {
    const fallbackServerId = params.fallbackServerId.trim();
    // Two Homes may publish the same Home-local folder id, so a folder id alone never identifies
    // an owner: only the exact qualified key does.
    const publishedServerIdsByFolderId = new Map<string, Set<string>>();
    for (const address of Object.values(params.orderItemAddressByItemKey)) {
        if (address.itemKind !== 'folder') continue;
        const serverIds = publishedServerIdsByFolderId.get(address.folderId) ?? new Set<string>();
        serverIds.add(address.serverId);
        publishedServerIdsByFolderId.set(address.folderId, serverIds);
    }
    const ownerForFolder = (folder: SessionFolderV1): string => {
        const workspaceServerId = (folder.workspace.serverId ?? '').trim();
        if (workspaceServerId) return workspaceServerId;
        const publishedServerIds = publishedServerIdsByFolderId.get(folder.id);
        const onlyPublishedServerId = publishedServerIds?.size === 1
            ? [...publishedServerIds][0]
            : null;
        return onlyPublishedServerId ?? fallbackServerId;
    };

    const currentByServerId = new Map<string, SessionFolderV1[]>();
    const nextByServerId = new Map<string, SessionFolderV1[]>();
    const collect = (
        target: Map<string, SessionFolderV1[]>,
        folders: readonly SessionFolderV1[],
    ): void => {
        for (const folder of folders) {
            const serverId = ownerForFolder(folder);
            if (!serverId) continue;
            const bucket = target.get(serverId) ?? [];
            bucket.push(folder);
            target.set(serverId, bucket);
        }
    };
    collect(currentByServerId, params.current.folders);
    collect(nextByServerId, params.next.folders);

    const writes: Record<string, Readonly<{ current: SessionFoldersV1; next: SessionFoldersV1 }>> = {};
    for (const serverId of new Set([...currentByServerId.keys(), ...nextByServerId.keys()])) {
        const current = currentByServerId.get(serverId) ?? [];
        const next = nextByServerId.get(serverId) ?? [];
        if (!hasSessionFolderWrite(current, next)) continue;
        writes[serverId] = {
            current: { v: 1, folders: current },
            next: { v: 1, folders: next },
        };
    }
    return writes;
}

function hasSessionFolderWrite(
    current: readonly SessionFolderV1[],
    next: readonly SessionFolderV1[],
): boolean {
    const currentById = new Map(current.map((folder) => [folder.id, folder]));
    if (next.some((folder) => {
        const previous = currentById.get(folder.id);
        return !previous || !areSessionFolderDefinitionsEqual(previous, folder);
    })) {
        return true;
    }
    const nextIds = new Set(next.map((folder) => folder.id));
    return current.some((folder) => !nextIds.has(folder.id));
}

export function buildSessionOrganizationListViewState(params: Readonly<{
    serverId: string;
    projection: SessionOrganizationProjection | null;
}>): SessionOrganizationListViewState {
    const serverId = params.serverId.trim();
    const projection = params.projection;
    if (!serverId || !projection) {
        return {
            pinnedSessionKeysV1: [],
            sessionFoldersV1: { v: 1, folders: [] },
            sessionFolderAssignmentsBySessionKey: {},
            sessionTagsV1: {},
            attentionStandingOverridesBySessionKey: {},
            sessionListGroupOrderV1: {},
            sessionWorkspaceOrderV1: {},
            workspaceLabelsV1: {},
            folderDisplayStatesByFolderKey: {},
            labelDisplayStatesByKey: {},
            sessionTagDisplayStatesBySessionKey: {},
            orderItemAddressByItemKey: {},
        };
    }

    const orderItemAddressByItemKey: Record<string, SessionOrganizationOrderItemAddress> = {};
    const mintSessionItemKey = (sessionIdRaw: string): string => {
        const itemKey = buildServerSessionKey(serverId, sessionIdRaw);
        const sessionId = String(sessionIdRaw ?? '').trim();
        if (sessionId) {
            orderItemAddressByItemKey[itemKey] = { itemKind: 'session', serverId, sessionId };
        }
        return itemKey;
    };
    const mintFolderItemKey = (folderIdRaw: string): string | null => {
        const folderId = folderIdRaw.trim();
        const itemKey = buildSessionListFolderOrderItemKey({ serverId, folderId });
        if (!itemKey) return null;
        orderItemAddressByItemKey[itemKey] = { itemKind: 'folder', serverId, folderId };
        return itemKey;
    };

    projection.orderedPinSessionIds.forEach(mintSessionItemKey);
    const pinnedSessionKeysV1 = projection.pinnedSessionIds.map((sessionId) => mintSessionItemKey(sessionId));
    const tagLabelsById = buildSessionOrganizationTagLabelById(projection.tagsById);
    const lockedUnreadable = {
        status: 'locked',
        reason: 'content_unreadable',
    } as const;
    const sessionTagDisplayStatesBySessionKey = Object.fromEntries(
        Object.entries(projection.tagAssignmentsBySessionId).map(([sessionId, tagIds]) => [
            mintSessionItemKey(sessionId),
            tagIds.map((tagId) => {
                const tag = projection.tagsById[tagId];
                const label = tagLabelsById[tagId];
                return {
                    tagId,
                    display: label
                        ? { status: 'available' as const, value: label }
                        : tag?.displayState.status === 'locked'
                            ? tag.displayState
                            : lockedUnreadable,
                };
            }),
        ]),
    );
    const sessionTagsV1 = sessionTagDisplayStatesBySessionKey;
    const attentionStandingOverridesBySessionKey = Object.fromEntries(
        Object.entries(projection.attentionStandingsBySessionId).map(([sessionId, standing]) => [
            mintSessionItemKey(sessionId),
            standing,
        ]),
    );
    const sessionFolderAssignmentsBySessionKey = Object.fromEntries(
        Object.entries(projection.folderAssignmentsBySessionId).map(([sessionId, folderId]) => [
            mintSessionItemKey(sessionId),
            folderId,
        ]),
    );

    const folderDisplayStatesByFolderKey: Record<string, HumanDisplayState> = {};
    const folders = Object.values(projection.foldersById)
        .filter((folder) => folder.archivedAt == null)
        .map((folder) => {
            const name = readFolderName(folder.displayState, folder.display);
            const workspace = readWorkspaceRef(folder.displayState, folder.display);
            mintFolderItemKey(folder.folderId);
            const folderKey = sessionFolderAddressKey({ serverId, folderId: folder.folderId });
            folderDisplayStatesByFolderKey[folderKey] = name
                ? { status: 'available', value: name }
                : folder.displayState.status === 'locked'
                    ? folder.displayState
                    : lockedUnreadable;
            return {
                id: folder.folderId,
                serverId,
                workspace: workspace ?? null,
                parentId: folder.parentFolderId,
                name: name ?? '',
                createdAt: folder.createdAt,
                updatedAt: folder.updatedAt,
                ...(folder.sortKey ? { sortKey: folder.sortKey } : {}),
                displayState: folderDisplayStatesByFolderKey[folderKey]!,
            };
        })
        .filter((folder): folder is NonNullable<typeof folder> => folder != null)
        .sort((a, b) => compareBySortKey(a, b)
            || a.name.localeCompare(b.name)
            || a.id.localeCompare(b.id));

    const sessionListGroupOrderV1: Record<string, string[]> = {};
    const sessionWorkspaceOrderV1: Record<string, string[]> = {};
    const workspaceLabelsV1: Record<string, HumanDisplayState> = {};
    const labelDisplayStatesByKey: Record<string, HumanDisplayState> = {};
    for (const entries of Object.values(projection.orderEntriesByScopeKey)) {
        const orderedEntries = [...entries].sort((a, b) => compareBySortKey(a, b) || a.itemKey.localeCompare(b.itemKey));
        for (const entry of orderedEntries) {
            if (entry.scopeKind === 'workspace') {
                const itemKey = normalizeWorkspaceItemKey(entry.itemKey);
                if (!itemKey) continue;
                appendOrderedValue(sessionWorkspaceOrderV1, normalizeWorkspaceScopeKey(serverId, entry.scopeKey), itemKey);
                continue;
            }
            const scopeKey = entry.scopeKind === 'pinned' ? PINNED_GROUP_KEY_V1 : entry.scopeKey.trim();
            const itemKey = entry.itemKind === 'session'
                ? mintSessionItemKey(entry.itemKey)
                : entry.itemKind === 'folder'
                    ? mintFolderItemKey(entry.itemKey)
                    : entry.itemKey.trim();
            if (scopeKey && itemKey) {
                appendOrderedValue(sessionListGroupOrderV1, scopeKey, itemKey);
            }
        }
    }
    for (const [labelKey, label] of Object.entries(projection.labelsByLabelKey)) {
        if (label.labelKind !== 'workspace' || label.archivedAt != null) continue;
        const displayLabel = readLabel(label.displayState, label.display);
        labelDisplayStatesByKey[labelKey] = displayLabel
            ? { status: 'available', value: displayLabel }
            : label.displayState.status === 'locked'
                ? label.displayState
                : lockedUnreadable;
        const scopeKey = label.scopeKey.trim();
        if (scopeKey) {
            workspaceLabelsV1[scopeKey] =
                labelDisplayStatesByKey[labelKey]!;
        }
    }

    return {
        pinnedSessionKeysV1,
        sessionFoldersV1: { v: 1, folders },
        sessionFolderAssignmentsBySessionKey,
        sessionTagsV1,
        attentionStandingOverridesBySessionKey,
        sessionListGroupOrderV1,
        sessionWorkspaceOrderV1,
        workspaceLabelsV1,
        folderDisplayStatesByFolderKey,
        labelDisplayStatesByKey,
        sessionTagDisplayStatesBySessionKey,
        orderItemAddressByItemKey,
    };
}

/**
 * Composes the canonical Home-local organization snapshots for one selected
 * multi-Home corpus. Session-owned facts are already qualified by
 * `buildSessionOrganizationListViewState`, so equal Home-local Session ids stay
 * distinct without introducing another store or merge cache.
 */
export function buildSessionOrganizationListViewStateForServers(params: Readonly<{
    serverIds: readonly string[];
    projectionsByServerId: Readonly<Record<string, SessionOrganizationProjection | null | undefined>>;
}>): SessionOrganizationListViewState {
    const states = [...new Set(params.serverIds.map((serverId) => serverId.trim()).filter(Boolean))]
        .map((serverId) => buildSessionOrganizationListViewState({
            serverId,
            projection: params.projectionsByServerId[serverId] ?? null,
        }));
    const mergeOrderedRecords = <T,>(
        records: readonly Readonly<Record<string, readonly T[] | undefined>>[],
    ): Record<string, readonly T[]> => {
        const result: Record<string, T[]> = {};
        for (const record of records) {
            for (const [key, values] of Object.entries(record)) {
                if (!values) continue;
                result[key] = [...(result[key] ?? []), ...values];
            }
        }
        return result;
    };

    return {
        pinnedSessionKeysV1: states.flatMap((state) => state.pinnedSessionKeysV1),
        sessionFoldersV1: {
            v: 1,
            folders: states.flatMap((state) => state.sessionFoldersV1.folders),
        },
        sessionFolderAssignmentsBySessionKey: Object.assign(
            {},
            ...states.map((state) => state.sessionFolderAssignmentsBySessionKey),
        ),
        sessionTagsV1: Object.assign({}, ...states.map((state) => state.sessionTagsV1)),
        attentionStandingOverridesBySessionKey: Object.assign(
            {},
            ...states.map((state) => state.attentionStandingOverridesBySessionKey),
        ),
        sessionListGroupOrderV1: mergeOrderedRecords(states.map((state) => state.sessionListGroupOrderV1)),
        sessionWorkspaceOrderV1: mergeOrderedRecords(states.map((state) => state.sessionWorkspaceOrderV1)),
        workspaceLabelsV1: Object.assign({}, ...states.map((state) => state.workspaceLabelsV1)),
        folderDisplayStatesByFolderKey: Object.assign({}, ...states.map((state) => state.folderDisplayStatesByFolderKey)),
        labelDisplayStatesByKey: Object.assign({}, ...states.map((state) => state.labelDisplayStatesByKey)),
        sessionTagDisplayStatesBySessionKey: Object.assign(
            {},
            ...states.map((state) => state.sessionTagDisplayStatesBySessionKey),
        ),
        orderItemAddressByItemKey: Object.assign(
            {},
            ...states.map((state) => state.orderItemAddressByItemKey),
        ),
    };
}
