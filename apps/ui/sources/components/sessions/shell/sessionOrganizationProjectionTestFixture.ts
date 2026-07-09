import type { SessionOrganizationProjection } from '@/sync/domains/session/organization';
import type {
    SessionOrganizationFolder,
    SessionOrganizationOrderEntry,
} from '@happier-dev/protocol';

type LegacySessionFolderFixture = Readonly<{
    id: string;
    workspace: unknown;
    parentId: string | null;
    name: string;
    createdAt: number;
    updatedAt: number;
    sortKey?: string | null;
}>;

export type LegacySessionOrganizationProjectionFixture = Readonly<{
    serverId: string;
    pinnedSessionKeysV1?: readonly string[];
    sessionTagsV1?: Readonly<Record<string, readonly string[]>>;
    sessionListGroupOrderV1?: Readonly<Record<string, readonly string[]>>;
    sessionFoldersV1?: Readonly<{
        folders?: readonly LegacySessionFolderFixture[];
    }>;
    folderAssignmentsBySessionId?: Readonly<Record<string, string | null>>;
}>;

function stripServerSessionKey(serverId: string, key: string): string | null {
    const prefix = `${serverId}:`;
    if (!key.startsWith(prefix)) return null;
    const sessionId = key.slice(prefix.length).trim();
    return sessionId || null;
}

function normalizeOrderScopeKey(serverId: string, scopeKey: string): string {
    return scopeKey.startsWith(`${serverId}:`) ? scopeKey : `${serverId}:${scopeKey}`;
}

function toOrderEntry(params: Readonly<{
    serverId: string;
    scopeKey: string;
    itemKey: string;
    index: number;
}>): SessionOrganizationOrderEntry {
    const isPinnedScope = params.scopeKey === 'pinned-v1';
    const isFolderItem = params.itemKey.startsWith('folder:');
    return {
        scopeKind: isPinnedScope ? 'pinned' : 'group',
        scopeKey: isPinnedScope ? 'pins' : params.scopeKey,
        itemKind: isFolderItem ? 'folder' : 'session',
        itemKey: isFolderItem
            ? params.itemKey.slice('folder:'.length)
            : stripServerSessionKey(params.serverId, params.itemKey) ?? params.itemKey,
        sortKey: String(params.index + 1).padStart(4, '0'),
    };
}

function toFolder(folder: LegacySessionFolderFixture, index: number): SessionOrganizationFolder {
    return {
        folderId: folder.id,
        folderKey: folder.id,
        parentFolderId: folder.parentId,
        parentFolderKey: folder.parentId,
        sortKey: folder.sortKey ?? String(index + 1).padStart(4, '0'),
        display: {
            t: 'plain',
            v: {
                name: folder.name,
                workspace: folder.workspace,
            },
        },
        archivedAt: null,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
    };
}

export function buildSessionOrganizationProjectionFromLegacyTestSettings(
    fixture: LegacySessionOrganizationProjectionFixture,
): SessionOrganizationProjection {
    const pinnedSessionIds = (fixture.pinnedSessionKeysV1 ?? [])
        .map((key) => stripServerSessionKey(fixture.serverId, key))
        .filter((sessionId): sessionId is string => sessionId != null);
    return {
        schemaVersion: 1,
        version: 1,
        pinnedSessionIds,
        pinsBySessionId: Object.fromEntries(pinnedSessionIds.map((sessionId, index) => [
            sessionId,
            { sessionId, sortKey: String(index + 1).padStart(4, '0'), pinnedAt: index + 1 },
        ])),
        foldersById: Object.fromEntries(
            (fixture.sessionFoldersV1?.folders ?? []).map((folder, index) => [
                folder.id,
                toFolder(folder, index),
            ]),
        ),
        folderAssignmentsBySessionId: fixture.folderAssignmentsBySessionId ?? {},
        tagsById: {},
        tagAssignmentsBySessionId: Object.fromEntries(
            Object.entries(fixture.sessionTagsV1 ?? {})
                .map(([key, tags]) => {
                    const sessionId = stripServerSessionKey(fixture.serverId, key);
                    return sessionId ? [sessionId, tags] : null;
                })
                .filter((entry): entry is [string, readonly string[]] => entry != null),
        ),
        orderEntriesByScopeKey: Object.fromEntries(
            Object.entries(fixture.sessionListGroupOrderV1 ?? {}).map(([scopeKey, itemKeys]) => [
                normalizeOrderScopeKey(fixture.serverId, scopeKey),
                itemKeys.map((itemKey, index) => toOrderEntry({
                    serverId: fixture.serverId,
                    scopeKey,
                    itemKey,
                    index,
                })),
            ]),
        ),
        labelsByLabelKey: {},
    };
}
