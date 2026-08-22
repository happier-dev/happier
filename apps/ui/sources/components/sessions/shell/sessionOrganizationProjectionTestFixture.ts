import type {
    SessionOrganizationProjection,
    UiSessionOrganizationFolder,
    UiSessionOrganizationTag,
} from '@/sync/domains/session/organization';
import type {
    SessionOrganizationContentEnvelope,
    SessionOrganizationOrderEntry,
} from '@happier-dev/protocol';

type SessionOrganizationJsonValue = Extract<
    SessionOrganizationContentEnvelope,
    { t: 'plain' }
>['v'];

type LegacySessionFolderFixture = Readonly<{
    id: string;
    workspace: SessionOrganizationJsonValue;
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

function toFolder(folder: LegacySessionFolderFixture, index: number): UiSessionOrganizationFolder {
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
        displayState: {
            status: 'available',
            value: {
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
    const tagIdByLabel = new Map<string, string>();
    const tagsById: Record<string, UiSessionOrganizationTag> = {};
    for (const tags of Object.values(fixture.sessionTagsV1 ?? {})) {
        for (const label of tags) {
            if (tagIdByLabel.has(label)) continue;
            const tagId = `fixture-tag-${tagIdByLabel.size + 1}`;
            tagIdByLabel.set(label, tagId);
            tagsById[tagId] = {
                tagId,
                tagKey: tagId,
                sortKey: null,
                display: { t: 'plain', v: { label } },
                displayState: { status: 'available', value: { label } },
                archivedAt: null,
                createdAt: 1,
                updatedAt: 1,
            };
        }
    }
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
        tagsById,
        tagAssignmentsBySessionId: Object.fromEntries(
            Object.entries(fixture.sessionTagsV1 ?? {})
                .flatMap(([key, tags]) => {
                    const sessionId = stripServerSessionKey(fixture.serverId, key);
                    return sessionId
                        ? [[
                            sessionId,
                            tags.map((label) => tagIdByLabel.get(label)!),
                        ] as const]
                        : [];
                }),
        ),
        attentionStandingsBySessionId: {},
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
