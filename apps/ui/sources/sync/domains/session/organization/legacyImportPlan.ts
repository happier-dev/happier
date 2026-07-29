import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
    SESSION_ORGANIZATION_MAX_ID_LENGTH,
    SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH,
    type ImportLegacySessionOrganizationRequest,
    type SessionOrganizationSnapshot,
} from '@happier-dev/protocol';
import {
    SessionFoldersV1Schema,
    type SessionFolderWorkspaceRefV1,
} from '@/sync/domains/session/folders';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';

import {
    buildSessionOrganizationReorderRequestFromGroupOrder,
    buildSessionOrganizationReorderRequestFromWorkspaceOrder,
} from './viewState';

export type LegacySessionTagAssignmentImport = Readonly<{
    sessionId: string;
    tagIds: readonly string[];
}>;

export type LegacySessionOrganizationImportPlan = Readonly<{
    request: ImportLegacySessionOrganizationRequest;
    tagAssignments: readonly LegacySessionTagAssignmentImport[];
    hasLegacyOrganizationSettings: boolean;
    hasImportableLegacyOrganization: boolean;
}>;

const LEGACY_SESSION_ORGANIZATION_KEYS = [
    'pinnedSessionKeysV1',
    'sessionFoldersV1',
    'sessionTagsV1',
    'sessionListGroupOrderV1',
    'sessionWorkspaceOrderV1',
    'workspaceLabelsV1',
] as const;

type LegacyOrganizationEntityKind = 'folder' | 'tag';

const textEncoder = new TextEncoder();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}

function readLegacyRecord(value: unknown): Record<string, unknown> {
    return isPlainRecord(value) ? value : {};
}

function buildSortKey(index: number): string {
    return String(index + 1).padStart(8, '0');
}

function normalizeLegacySortKey(value: unknown, index: number): string | null {
    const sortKey = typeof value === 'string' ? value.trim() : '';
    if (!sortKey) return null;
    if (sortKey.length <= SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH) return sortKey;
    return buildSortKey(index);
}

function sanitizeLegacyEntityIdPrefix(value: string): string {
    return value
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'legacy';
}

function buildProviderSafeLegacyEntityId(kind: LegacyOrganizationEntityKind, legacyId: string): string {
    const trimmed = legacyId.trim();
    if (trimmed.length <= SESSION_ORGANIZATION_MAX_ID_LENGTH) return trimmed;

    const digest = bytesToHex(sha256(textEncoder.encode(`${kind}:${trimmed}`))).slice(0, 48);
    const prefix = `${kind}_legacy_`;
    const readable = sanitizeLegacyEntityIdPrefix(trimmed);
    const readableLength = Math.max(0, SESSION_ORGANIZATION_MAX_ID_LENGTH - prefix.length - digest.length - 1);
    return `${prefix}${readable.slice(0, readableLength)}_${digest}`;
}

function allocateUniqueLegacyEntityId(baseId: string, usedIds: Set<string>): string {
    if (!usedIds.has(baseId)) {
        usedIds.add(baseId);
        return baseId;
    }

    for (let suffix = 2; suffix < 10_000; suffix += 1) {
        const suffixText = `_${suffix}`;
        const candidate = `${baseId.slice(0, SESSION_ORGANIZATION_MAX_ID_LENGTH - suffixText.length)}${suffixText}`;
        if (!usedIds.has(candidate)) {
            usedIds.add(candidate);
            return candidate;
        }
    }
    throw new Error('legacy session organization id allocation exhausted');
}

function createLegacyEntityIdResolver(kind: LegacyOrganizationEntityKind): (legacyId: string) => string {
    const idsByLegacyId = new Map<string, string>();
    const usedIds = new Set<string>();

    return (legacyId) => {
        const trimmed = legacyId.trim();
        const existing = idsByLegacyId.get(trimmed);
        if (existing) return existing;
        const providerSafeId = allocateUniqueLegacyEntityId(
            buildProviderSafeLegacyEntityId(kind, trimmed),
            usedIds,
        );
        idsByLegacyId.set(trimmed, providerSafeId);
        return providerSafeId;
    };
}

function stripServerSessionKey(serverId: string, value: unknown): string | null {
    const sessionKey = typeof value === 'string' ? value.trim() : '';
    if (!sessionKey) return null;
    const prefix = `${serverId}:`;
    if (sessionKey.startsWith(prefix)) return sessionKey.slice(prefix.length).trim() || null;
    return sessionKey.includes(':') ? null : sessionKey;
}

function belongsToCurrentServerScope(serverId: string, scopeKeyRaw: unknown): boolean {
    const scopeKey = typeof scopeKeyRaw === 'string' ? scopeKeyRaw.trim() : '';
    if (!scopeKey) return false;
    const match = /^server:([^:]+)(?::|$)/.exec(scopeKey);
    return !match || match[1] === serverId;
}

function normalizeWorkspaceForServer(
    serverId: string,
    workspace: SessionFolderWorkspaceRefV1,
): SessionFolderWorkspaceRefV1 {
    const workspaceServerId = typeof workspace.serverId === 'string' && workspace.serverId.trim()
        ? workspace.serverId.trim()
        : serverId;
    return {
        ...workspace,
        serverId: workspaceServerId,
    };
}

function readLegacyFolders(params: {
    serverId: string;
    value: unknown;
}): {
    folders: ImportLegacySessionOrganizationRequest['folders'];
    folderIdsByLegacyId: ReadonlyMap<string, string>;
} {
    const parsed = SessionFoldersV1Schema.safeParse(params.value);
    if (!parsed.success) {
        return { folders: [], folderIdsByLegacyId: new Map() };
    }

    const eligible = parsed.data.folders
        .map((folder) => {
            const folderId = folder.id.trim();
            if (!folderId) return null;
            const workspace = normalizeWorkspaceForServer(params.serverId, folder.workspace);
            if (workspace.serverId !== params.serverId) return null;
            return { folder, folderId, workspace };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const resolveFolderId = createLegacyEntityIdResolver('folder');
    const folderIdsByLegacyId = new Map<string, string>();
    for (const { folderId } of eligible) {
        folderIdsByLegacyId.set(folderId, resolveFolderId(folderId));
    }
    const eligibleIds = new Set(folderIdsByLegacyId.keys());
    const folders: ImportLegacySessionOrganizationRequest['folders'] = eligible.map(({ folder, folderId, workspace }, index) => {
        const legacyParentFolderId = typeof folder.parentId === 'string' && eligibleIds.has(folder.parentId.trim())
            ? folder.parentId.trim()
            : null;
        const parentFolderId = legacyParentFolderId ? folderIdsByLegacyId.get(legacyParentFolderId) ?? null : null;
        return {
            folderId: folderIdsByLegacyId.get(folderId) ?? folderId,
            folderKey: folderId,
            parentFolderId,
            parentFolderKey: legacyParentFolderId,
            sortKey: normalizeLegacySortKey(folder.sortKey, index),
            display: {
                t: 'plain' as const,
                v: {
                    name: folder.name,
                    workspace,
                },
            },
        };
    });

    return { folders, folderIdsByLegacyId };
}

function readLegacyPins(params: {
    serverId: string;
    value: unknown;
}): ImportLegacySessionOrganizationRequest['pins'] {
    const pins: ImportLegacySessionOrganizationRequest['pins'] = [];
    const seen = new Set<string>();
    for (const [index, rawSessionKey] of readStringArray(params.value).entries()) {
        const sessionId = stripServerSessionKey(params.serverId, rawSessionKey);
        if (!sessionId || seen.has(sessionId)) continue;
        seen.add(sessionId);
        pins.push({ sessionId, sortKey: buildSortKey(index) });
    }
    return pins;
}

function readLegacyTags(params: {
    serverId: string;
    value: unknown;
}): {
    tags: ImportLegacySessionOrganizationRequest['tags'];
    tagAssignments: LegacySessionTagAssignmentImport[];
    tagIdsByLegacyId: ReadonlyMap<string, string>;
} {
    const tags: ImportLegacySessionOrganizationRequest['tags'] = [];
    const tagAssignments: LegacySessionTagAssignmentImport[] = [];
    const seenTagKeys = new Set<string>();
    const resolveTagId = createLegacyEntityIdResolver('tag');
    const tagIdsByLegacyId = new Map<string, string>();

    for (const [rawSessionKey, rawTags] of Object.entries(readLegacyRecord(params.value))) {
        const sessionId = stripServerSessionKey(params.serverId, rawSessionKey);
        if (!sessionId) continue;
        const tagIds: string[] = [];
        const seenForSession = new Set<string>();
        for (const rawTagId of readStringArray(rawTags)) {
            const tagKey = rawTagId.trim();
            if (!tagKey || seenForSession.has(tagKey)) continue;
            seenForSession.add(tagKey);
            const tagId = resolveTagId(tagKey);
            tagIdsByLegacyId.set(tagKey, tagId);
            tagIds.push(tagId);
            if (seenTagKeys.has(tagKey)) continue;
            seenTagKeys.add(tagKey);
            tags.push({
                tagId,
                tagKey,
                sortKey: buildSortKey(tags.length),
                display: { t: 'plain', v: { label: tagKey } },
            });
        }
        if (tagIds.length > 0) {
            tagAssignments.push({ sessionId, tagIds });
        }
    }

    return { tags, tagAssignments, tagIdsByLegacyId };
}

function readLegacyGroupOrder(params: {
    serverId: string;
    value: unknown;
    folderIdsByLegacyId: ReadonlyMap<string, string>;
}): ImportLegacySessionOrganizationRequest['orderEntries'] {
    const orderEntries: ImportLegacySessionOrganizationRequest['orderEntries'] = [];
    for (const [scopeKey, rawItemKeys] of Object.entries(readLegacyRecord(params.value))) {
        if (!belongsToCurrentServerScope(params.serverId, scopeKey)) continue;
        const normalizedScopeKey = normalizeLegacyGroupOrderScopeKey(scopeKey, params.folderIdsByLegacyId);
        if (!normalizedScopeKey) continue;
        const itemKeys = readStringArray(rawItemKeys)
            .map((itemKey) => normalizeLegacyGroupOrderItemKey(itemKey, params.folderIdsByLegacyId))
            .filter((itemKey): itemKey is string => itemKey !== null);
        const request = buildSessionOrganizationReorderRequestFromGroupOrder({
            serverId: params.serverId,
            scopeKey: normalizedScopeKey,
            itemKeys,
        });
        if (!request || request.entries.length === 0) continue;
        orderEntries.push(
            ...request.entries.map((entry) => ({
                scopeKind: request.scopeKind,
                scopeKey: request.scopeKey,
                ...entry,
            })),
        );
    }
    return orderEntries;
}

function normalizeLegacyGroupOrderScopeKey(
    scopeKeyRaw: string,
    folderIdsByLegacyId: ReadonlyMap<string, string>,
): string | null {
    const scopeKey = scopeKeyRaw.trim();
    if (!scopeKey.startsWith('folder:')) return scopeKey;
    const legacyFolderId = scopeKey.slice('folder:'.length).trim();
    if (!legacyFolderId) return null;
    const folderId = folderIdsByLegacyId.get(legacyFolderId);
    return folderId ? `folder:${folderId}` : null;
}

function normalizeLegacyGroupOrderItemKey(
    itemKeyRaw: string,
    folderIdsByLegacyId: ReadonlyMap<string, string>,
): string | null {
    const itemKey = itemKeyRaw.trim();
    if (!itemKey.startsWith('folder:')) return itemKey;
    const legacyFolderId = itemKey.slice('folder:'.length).trim();
    if (!legacyFolderId) return null;
    const folderId = folderIdsByLegacyId.get(legacyFolderId);
    return folderId ? `folder:${folderId}` : null;
}

function readLegacyWorkspaceOrder(params: {
    serverId: string;
    value: unknown;
}): ImportLegacySessionOrganizationRequest['orderEntries'] {
    const orderEntries: ImportLegacySessionOrganizationRequest['orderEntries'] = [];
    for (const [scopeKey, rawItemKeys] of Object.entries(readLegacyRecord(params.value))) {
        if (!belongsToCurrentServerScope(params.serverId, scopeKey)) continue;
        const request = buildSessionOrganizationReorderRequestFromWorkspaceOrder({
            serverId: params.serverId,
            scopeKey,
            itemKeys: readStringArray(rawItemKeys),
        });
        if (!request || request.entries.length === 0) continue;
        orderEntries.push(
            ...request.entries.map((entry) => ({
                scopeKind: request.scopeKind,
                scopeKey: request.scopeKey,
                ...entry,
            })),
        );
    }
    return orderEntries;
}

function readLegacyLabels(params: {
    serverId: string;
    value: unknown;
}): ImportLegacySessionOrganizationRequest['labels'] {
    const labels: ImportLegacySessionOrganizationRequest['labels'] = [];
    for (const [scopeKey, rawLabel] of Object.entries(readLegacyRecord(params.value))) {
        if (!belongsToCurrentServerScope(params.serverId, scopeKey)) continue;
        const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
        if (!label) continue;
        labels.push({
            labelKind: 'workspace',
            scopeKey,
            display: { t: 'plain', v: { label } },
        });
    }
    return labels;
}

function hasLegacyOrganizationSettings(rawSettings: Record<string, unknown>): boolean {
    return LEGACY_SESSION_ORGANIZATION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(rawSettings, key));
}

function hasServerScopePrefix(scopeKeyRaw: unknown): boolean {
    const scopeKey = typeof scopeKeyRaw === 'string' ? scopeKeyRaw.trim() : '';
    return /^server:([^:]+)(?::|$)/.test(scopeKey);
}

function shouldKeepLegacySessionKeyAfterImport(serverId: string, value: unknown): boolean {
    return stripServerSessionKey(serverId, value) === null;
}

function shouldKeepLegacyOrderItemAfterImport(params: Readonly<{
    serverId: string;
    value: unknown;
    currentServerFolderIds: ReadonlySet<string>;
}>): boolean {
    const itemKey = typeof params.value === 'string' ? params.value.trim() : '';
    if (!itemKey) return false;
    if (stripServerSessionKey(params.serverId, itemKey) !== null) return false;
    const folderPrefix = 'folder:';
    if (itemKey.startsWith(folderPrefix)) {
        const folderId = itemKey.slice(folderPrefix.length).trim();
        return !folderId || !params.currentServerFolderIds.has(folderId);
    }
    return true;
}

function currentServerFolderIdsFromLegacyFolders(serverId: string, value: unknown): ReadonlySet<string> {
    const ids = new Set<string>();
    const parsed = SessionFoldersV1Schema.safeParse(value);
    if (!parsed.success) return ids;
    for (const folder of parsed.data.folders) {
        const folderId = folder.id.trim();
        if (!folderId) continue;
        const workspace = normalizeWorkspaceForServer(serverId, folder.workspace);
        if (workspace.serverId === serverId) ids.add(folderId);
    }
    return ids;
}

function stripLegacyPinsForServer(serverId: string, value: unknown): string[] | undefined {
    const remaining = readStringArray(value).filter((sessionKey) => shouldKeepLegacySessionKeyAfterImport(serverId, sessionKey));
    return remaining.length > 0 ? remaining : undefined;
}

function stripLegacyFoldersForServer(serverId: string, value: unknown): unknown {
    const parsed = SessionFoldersV1Schema.safeParse(value);
    if (!parsed.success) return value;
    const remaining = parsed.data.folders.filter((folder) => {
        const workspace = normalizeWorkspaceForServer(serverId, folder.workspace);
        return workspace.serverId !== serverId;
    });
    return remaining.length > 0 ? { ...parsed.data, folders: remaining } : undefined;
}

function stripLegacyTagsForServer(serverId: string, value: unknown): Record<string, unknown> | undefined {
    const remaining = Object.fromEntries(
        Object.entries(readLegacyRecord(value))
            .filter(([sessionKey]) => shouldKeepLegacySessionKeyAfterImport(serverId, sessionKey)),
    );
    return Object.keys(remaining).length > 0 ? remaining : undefined;
}

function stripLegacyGroupOrderForServer(params: Readonly<{
    serverId: string;
    value: unknown;
    currentServerFolderIds: ReadonlySet<string>;
}>): Record<string, string[]> | undefined {
    const remaining: Record<string, string[]> = {};
    for (const [scopeKey, rawItemKeys] of Object.entries(readLegacyRecord(params.value))) {
        if (hasServerScopePrefix(scopeKey) && !belongsToCurrentServerScope(params.serverId, scopeKey)) {
            const itemKeys = readStringArray(rawItemKeys);
            if (itemKeys.length > 0) remaining[scopeKey] = itemKeys;
            continue;
        }
        const itemKeys = readStringArray(rawItemKeys).filter((itemKey) =>
            shouldKeepLegacyOrderItemAfterImport({
                serverId: params.serverId,
                value: itemKey,
                currentServerFolderIds: params.currentServerFolderIds,
            }),
        );
        if (itemKeys.length > 0) remaining[scopeKey] = itemKeys;
    }
    return Object.keys(remaining).length > 0 ? remaining : undefined;
}

function stripServerScopedRecordForServer(serverId: string, value: unknown): Record<string, unknown> | undefined {
    const remaining = Object.fromEntries(
        Object.entries(readLegacyRecord(value))
            .filter(([scopeKey]) => !belongsToCurrentServerScope(serverId, scopeKey)),
    );
    return Object.keys(remaining).length > 0 ? remaining : undefined;
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
    if (value !== undefined) target[key] = value;
}

export function stripImportedLegacySessionOrganizationSettingsForServer<TSettings extends Record<string, unknown>>(params: Readonly<{
    serverId: string;
    rawSettings: TSettings;
}>): TSettings;
export function stripImportedLegacySessionOrganizationSettingsForServer(params: Readonly<{
    serverId: string;
    rawSettings: Record<string, unknown> | null | undefined;
}>): Record<string, unknown>;
export function stripImportedLegacySessionOrganizationSettingsForServer(params: Readonly<{
    serverId: string;
    rawSettings: Record<string, unknown> | null | undefined;
}>): Record<string, unknown> {
    const serverId = params.serverId.trim();
    const rawSettings = params.rawSettings && isPlainRecord(params.rawSettings) ? params.rawSettings : {};
    if (!serverId) return { ...rawSettings };

    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawSettings)) {
        if (!(LEGACY_SESSION_ORGANIZATION_KEYS as readonly string[]).includes(key)) {
            stripped[key] = value;
        }
    }

    const currentServerFolderIds = currentServerFolderIdsFromLegacyFolders(serverId, rawSettings.sessionFoldersV1);
    assignIfDefined(stripped, 'pinnedSessionKeysV1', stripLegacyPinsForServer(serverId, rawSettings.pinnedSessionKeysV1));
    assignIfDefined(stripped, 'sessionFoldersV1', stripLegacyFoldersForServer(serverId, rawSettings.sessionFoldersV1));
    assignIfDefined(stripped, 'sessionTagsV1', stripLegacyTagsForServer(serverId, rawSettings.sessionTagsV1));
    assignIfDefined(stripped, 'sessionListGroupOrderV1', stripLegacyGroupOrderForServer({
        serverId,
        value: rawSettings.sessionListGroupOrderV1,
        currentServerFolderIds,
    }));
    assignIfDefined(stripped, 'sessionWorkspaceOrderV1', stripServerScopedRecordForServer(serverId, rawSettings.sessionWorkspaceOrderV1));
    assignIfDefined(stripped, 'workspaceLabelsV1', stripServerScopedRecordForServer(serverId, rawSettings.workspaceLabelsV1));
    return stripped;
}

function hasImportableValues(
    request: ImportLegacySessionOrganizationRequest,
    tagAssignments: readonly LegacySessionTagAssignmentImport[],
): boolean {
    return request.pins.length > 0
        || request.folders.length > 0
        || request.tags.length > 0
        || request.orderEntries.length > 0
        || request.labels.length > 0
        || tagAssignments.length > 0;
}

function orderEntryIdentity(entry: ImportLegacySessionOrganizationRequest['orderEntries'][number]): string {
    return `${entry.scopeKind}\u0000${entry.scopeKey}\u0000${entry.itemKind}\u0000${entry.itemKey}`;
}

function labelIdentity(label: ImportLegacySessionOrganizationRequest['labels'][number]): string {
    return `${label.labelKind}\u0000${label.scopeKey}`;
}

function pruneImportedCategories(params: {
    request: ImportLegacySessionOrganizationRequest;
    tagAssignments: readonly LegacySessionTagAssignmentImport[];
    existingSnapshot: SessionOrganizationSnapshot | null | undefined;
}): {
    request: ImportLegacySessionOrganizationRequest;
    tagAssignments: readonly LegacySessionTagAssignmentImport[];
} {
    const snapshot = params.existingSnapshot;
    if (!snapshot) return { request: params.request, tagAssignments: params.tagAssignments };

    const existingPinSessionIds = new Set(snapshot.pins.map((pin) => pin.sessionId));
    const existingFolderIdsAndKeys = new Set<string>();
    for (const folder of snapshot.folders) {
        if (folder.archivedAt != null) continue;
        existingFolderIdsAndKeys.add(folder.folderId);
        existingFolderIdsAndKeys.add(folder.folderKey);
    }
    const existingTagIds = new Set(
        snapshot.tags
            .filter((tag) => tag.archivedAt == null)
            .map((tag) => tag.tagId),
    );
    const existingTagAssignmentsBySessionId = new Map(
        snapshot.tagAssignments.map((assignment) => [assignment.sessionId, assignment.tagIds] as const),
    );
    const existingOrderEntryIdentities = new Set(snapshot.orderEntries.map(orderEntryIdentity));
    const existingLabelIdentities = new Set(
        snapshot.labels
            .filter((label) => label.archivedAt == null)
            .map(labelIdentity),
    );
    const tagAssignments = params.tagAssignments.flatMap((assignment) => {
        const existingTagIdsForSession = existingTagAssignmentsBySessionId.get(assignment.sessionId) ?? [];
        const existingTagIdSetForSession = new Set(existingTagIdsForSession);
        const hasEveryLegacyTag = assignment.tagIds.every((tagId) => existingTagIdSetForSession.has(tagId));
        if (hasEveryLegacyTag) return [];
        const mergedTagIds = [...existingTagIdsForSession];
        for (const tagId of assignment.tagIds) {
            if (!existingTagIdSetForSession.has(tagId)) {
                existingTagIdSetForSession.add(tagId);
                mergedTagIds.push(tagId);
            }
        }
        return [{ sessionId: assignment.sessionId, tagIds: mergedTagIds }];
    });

    return {
        request: {
            pins: params.request.pins.filter((pin) => !existingPinSessionIds.has(pin.sessionId)),
            folders: params.request.folders.filter((folder) => {
                const folderId = folder.folderId ?? folder.folderKey;
                return !existingFolderIdsAndKeys.has(folderId) && !existingFolderIdsAndKeys.has(folder.folderKey);
            }),
            tags: params.request.tags.filter((tag) => !existingTagIds.has(tag.tagId ?? tag.tagKey)),
            tagAssignments: tagAssignments.map((assignment) => ({
                sessionId: assignment.sessionId,
                tagIds: [...assignment.tagIds],
            })),
            orderEntries: params.request.orderEntries.filter((entry) => !existingOrderEntryIdentities.has(orderEntryIdentity(entry))),
            labels: params.request.labels.filter((label) => !existingLabelIdentities.has(labelIdentity(label))),
        },
        tagAssignments,
    };
}

export function buildLegacySessionOrganizationImportPlan(params: Readonly<{
    serverId: string;
    rawSettings: Record<string, unknown> | null | undefined;
    existingSnapshot?: SessionOrganizationSnapshot | null;
}>): LegacySessionOrganizationImportPlan {
    const serverId = params.serverId.trim();
    const rawSettings = params.rawSettings && isPlainRecord(params.rawSettings) ? params.rawSettings : {};
    const hasLegacy = serverId ? hasLegacyOrganizationSettings(rawSettings) : false;
    const folderPlan = readLegacyFolders({ serverId, value: rawSettings.sessionFoldersV1 });
    const tagPlan = readLegacyTags({ serverId, value: rawSettings.sessionTagsV1 });
    const request: ImportLegacySessionOrganizationRequest = {
        pins: readLegacyPins({ serverId, value: rawSettings.pinnedSessionKeysV1 }),
        folders: folderPlan.folders,
        tags: tagPlan.tags,
        tagAssignments: tagPlan.tagAssignments.map((assignment) => ({
            sessionId: assignment.sessionId,
            tagIds: [...assignment.tagIds],
        })),
        orderEntries: [
            ...readLegacyGroupOrder({
                serverId,
                value: rawSettings.sessionListGroupOrderV1,
                folderIdsByLegacyId: folderPlan.folderIdsByLegacyId,
            }),
            ...readLegacyWorkspaceOrder({ serverId, value: rawSettings.sessionWorkspaceOrderV1 }),
        ],
        labels: readLegacyLabels({ serverId, value: rawSettings.workspaceLabelsV1 }),
    };
    const pruned = pruneImportedCategories({
        request,
        tagAssignments: tagPlan.tagAssignments,
        existingSnapshot: params.existingSnapshot,
    });

    return {
        request: pruned.request,
        tagAssignments: pruned.tagAssignments,
        hasLegacyOrganizationSettings: hasLegacy,
        hasImportableLegacyOrganization: hasImportableValues(pruned.request, pruned.tagAssignments),
    };
}
