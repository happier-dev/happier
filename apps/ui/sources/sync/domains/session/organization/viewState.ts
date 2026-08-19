import type { SessionFolderWorkspaceRefV1, SessionFoldersV1 } from '@/sync/domains/session/folders';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import {
    buildSessionWorkspaceOrderScopeKey,
    type SessionWorkspaceOrderV1,
} from '@/sync/domains/session/listing/sessionWorkspaceOrderStateV1';
import type { ReorderSessionOrganizationRequest } from '@happier-dev/protocol';

import type { SessionOrganizationProjection } from './types';
import { buildSessionOrganizationTagLabelById } from './tagLabels';

export type SessionOrganizationListViewState = Readonly<{
    pinnedSessionKeysV1: readonly string[];
    sessionFoldersV1: SessionFoldersV1;
    sessionFolderAssignmentsBySessionKey: Record<string, string | null>;
    sessionTagsV1: Record<string, readonly string[]>;
    attentionStandingOverridesBySessionKey: Record<string, boolean>;
    sessionListGroupOrderV1: Record<string, readonly string[]>;
    sessionWorkspaceOrderV1: SessionWorkspaceOrderV1;
    workspaceLabelsV1: Record<string, string>;
}>;

function buildServerSessionKey(serverId: string, sessionId: string): string {
    const trimmedSessionId = String(sessionId ?? '').trim();
    return trimmedSessionId.includes(':') ? trimmedSessionId : `${serverId}:${trimmedSessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPlainDisplayRecord(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value) || value.t !== 'plain' || !isRecord(value.v)) return null;
    return value.v;
}

function readFolderName(display: unknown): string | null {
    const record = readPlainDisplayRecord(display);
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    return name || null;
}

function readLabel(display: unknown): string | null {
    const record = readPlainDisplayRecord(display);
    const label = typeof record?.label === 'string' ? record.label.trim() : '';
    return label || null;
}

function readWorkspaceRef(display: unknown): SessionFolderWorkspaceRefV1 | null {
    const record = readPlainDisplayRecord(display);
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
    const trimmed = itemKey.trim();
    if (!trimmed) return null;
    return trimmed.startsWith('workspace:') ? trimmed : `workspace:${trimmed}`;
}

function normalizeWorkspaceScopeKey(serverId: string, scopeKey: string): string {
    const trimmed = scopeKey.trim();
    return trimmed.startsWith('server:') ? trimmed : buildSessionWorkspaceOrderScopeKey(trimmed || serverId);
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

function stripServerSessionKey(serverId: string, itemKeyRaw: string): string | null {
    const itemKey = itemKeyRaw.trim();
    if (!itemKey) return null;
    const prefix = `${serverId}:`;
    if (itemKey.startsWith(prefix)) return itemKey.slice(prefix.length).trim() || null;
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

export function buildSessionOrganizationReorderRequestFromGroupOrder(params: Readonly<{
    serverId: string;
    scopeKey: string;
    itemKeys: readonly string[];
}>): ReorderSessionOrganizationRequest | null {
    const serverId = params.serverId.trim();
    const legacyScopeKey = params.scopeKey.trim();
    if (!serverId || !legacyScopeKey) return null;
    const scopeKind = legacyScopeKey === PINNED_GROUP_KEY_V1 ? 'pinned' : 'group';
    const scopeKey = scopeKind === 'pinned' ? 'pins' : legacyScopeKey;
    const entries: ReorderSessionOrganizationRequest['entries'] = [];
    const seen = new Set<string>();
    for (const [index, rawItemKey] of params.itemKeys.entries()) {
        const trimmed = typeof rawItemKey === 'string' ? rawItemKey.trim() : '';
        if (!trimmed) continue;
        const isFolder = trimmed.startsWith('folder:');
        const itemKey = isFolder ? stripFolderItemKey(trimmed) : stripServerSessionKey(serverId, trimmed);
        if (!itemKey) continue;
        const dedupeKey = `${isFolder ? 'folder' : 'session'}:${itemKey}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
            itemKind: isFolder ? 'folder' : 'session',
            itemKey,
            sortKey: buildSortKey(index),
        });
    }
    return { scopeKind, scopeKey, entries };
}

export function buildSessionOrganizationReorderRequestFromWorkspaceOrder(params: Readonly<{
    serverId: string;
    scopeKey: string;
    itemKeys: readonly string[];
}>): ReorderSessionOrganizationRequest | null {
    const serverId = params.serverId.trim();
    const legacyScopeKey = params.scopeKey.trim();
    if (!serverId || !legacyScopeKey) return null;
    const expectedScopeKey = buildSessionWorkspaceOrderScopeKey(serverId);
    const scopeKey = legacyScopeKey === expectedScopeKey ? serverId : legacyScopeKey;
    const entries: ReorderSessionOrganizationRequest['entries'] = [];
    const seen = new Set<string>();
    for (const [index, rawItemKey] of params.itemKeys.entries()) {
        const itemKey = stripWorkspaceItemKey(typeof rawItemKey === 'string' ? rawItemKey : '');
        if (!itemKey || seen.has(itemKey)) continue;
        seen.add(itemKey);
        entries.push({
            itemKind: 'workspace',
            itemKey,
            sortKey: buildSortKey(index),
        });
    }
    return { scopeKind: 'workspace', scopeKey, entries };
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
        };
    }

    const pinnedSessionKeysV1 = projection.pinnedSessionIds.map((sessionId) => buildServerSessionKey(serverId, sessionId));
    const tagLabelsById = buildSessionOrganizationTagLabelById(projection.tagsById);
    const sessionTagsV1 = Object.fromEntries(
        Object.entries(projection.tagAssignmentsBySessionId).map(([sessionId, tagIds]) => [
            buildServerSessionKey(serverId, sessionId),
            tagIds.map((tagId) => tagLabelsById[tagId] ?? tagId),
        ]),
    );
    const attentionStandingOverridesBySessionKey = Object.fromEntries(
        Object.entries(projection.attentionStandingsBySessionId).map(([sessionId, standing]) => [
            buildServerSessionKey(serverId, sessionId),
            standing.standing,
        ]),
    );
    const sessionFolderAssignmentsBySessionKey = Object.fromEntries(
        Object.entries(projection.folderAssignmentsBySessionId).map(([sessionId, folderId]) => [
            buildServerSessionKey(serverId, sessionId),
            folderId,
        ]),
    );

    const folders = Object.values(projection.foldersById)
        .filter((folder) => folder.archivedAt == null)
        .map((folder) => {
            const name = readFolderName(folder.display);
            const workspace = readWorkspaceRef(folder.display);
            if (!name || !workspace) return null;
            return {
                id: folder.folderId,
                workspace,
                parentId: folder.parentFolderId,
                name,
                createdAt: folder.createdAt,
                updatedAt: folder.updatedAt,
                ...(folder.sortKey ? { sortKey: folder.sortKey } : {}),
            };
        })
        .filter((folder): folder is NonNullable<typeof folder> => folder != null)
        .sort((a, b) => compareBySortKey(a, b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const sessionListGroupOrderV1: Record<string, string[]> = {};
    const sessionWorkspaceOrderV1: Record<string, string[]> = {};
    const workspaceLabelsV1: Record<string, string> = {};
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
                ? buildServerSessionKey(serverId, entry.itemKey)
                : entry.itemKind === 'folder'
                    ? `folder:${entry.itemKey.trim().replace(/^folder:/, '')}`
                    : entry.itemKey.trim();
            if (scopeKey && itemKey) {
                appendOrderedValue(sessionListGroupOrderV1, scopeKey, itemKey);
            }
        }
    }
    for (const label of Object.values(projection.labelsByLabelKey)) {
        if (label.labelKind !== 'workspace' || label.archivedAt != null) continue;
        const displayLabel = readLabel(label.display);
        if (!displayLabel) continue;
        const scopeKey = label.scopeKey.trim();
        if (scopeKey) {
            workspaceLabelsV1[scopeKey] = displayLabel;
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
    };
}
