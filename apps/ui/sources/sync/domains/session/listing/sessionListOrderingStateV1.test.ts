import { describe, expect, it, vi } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListViewItem } from './sessionListViewData';
import { sessionAddressKey } from '../sessionAddress';
import {
    normalizeSessionListGroupOrderV1ForSource,
    normalizeSessionListGroupOrderV1ForIndexSource,
    PINNED_GROUP_KEY_V1,
    sortSessionListViewItemsByOrderingMode,
} from './sessionListOrderingStateV1';
import {
    applySessionWorkspaceOrderV1ToIndex,
    buildSessionWorkspaceOrderItemKey,
    buildSessionWorkspaceOrderScopeKey,
    normalizeSessionWorkspaceOrderV1ForSource,
} from './sessionWorkspaceOrderStateV1';
import {
    buildSessionProjectGroupingIdentity,
    sessionProjectGroupingIdentityKey,
} from './sessionListProjectGroupingKeys';
import { buildSessionListFolderOrderItemKey } from '@/sync/domains/session/listing/sessionListOrderingStateV1';

function folderOrderKey(folderId: string): string {
    return buildSessionListFolderOrderItemKey({ serverId: 's1', folderId })!;
}


function makeSessionItem(
    opts: Readonly<{ serverId: string; sessionId: string; groupKey: string }>,
): Extract<SessionListViewItem, { type: 'session' }> {
    return {
        type: 'session',
        serverId: opts.serverId,
        session: { id: opts.sessionId } as any,
        groupKey: opts.groupKey,
    };
}

describe('sessionListOrderingStateV1', () => {
    it('returns the original array when custom ordering is a no-op', () => {
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: 'g' }),
        ];

        expect(sortSessionListViewItemsByOrderingMode(source, 'custom')).toBe(source);
    });

    it('returns the original array when created ordering is already satisfied', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        (firstSession.session as any).createdAt = 20;
        (secondSession.session as any).createdAt = 10;

        expect(sortSessionListViewItemsByOrderingMode(source, 'created')).toBe(source);
    });

    it('does not sort already ordered updated-mode groups', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        Object.assign(firstSession.session, { createdAt: 20, updatedAt: 20, meaningfulActivityAt: 650_000 });
        Object.assign(secondSession.session, { createdAt: 10, updatedAt: 10, meaningfulActivityAt: 100 });

        const sortSpy = vi.spyOn(Array.prototype, 'sort');
        try {
            expect(sortSessionListViewItemsByOrderingMode(source, 'updated')).toBe(source);
            expect(sortSpy).not.toHaveBeenCalled();
        } finally {
            sortSpy.mockRestore();
        }
    });

    it('keeps updated-mode groups ordered when meaningful activity remains in the same bucket', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'stable-first', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'raw-newer', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        Object.assign(firstSession.session, {
            createdAt: 200,
            updatedAt: 100,
            meaningfulActivityAt: 650_000,
        });
        Object.assign(secondSession.session, {
            createdAt: 100,
            updatedAt: 900_000,
            meaningfulActivityAt: 640_000,
        });

        expect(sortSessionListViewItemsByOrderingMode(source, 'updated')).toBe(source);
    });

    it('sorts updated-mode groups when meaningful activity crosses a bucket boundary', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'older-bucket', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'newer-bucket', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        Object.assign(firstSession.session, {
            createdAt: 200,
            updatedAt: 900_000,
            meaningfulActivityAt: 590_000,
        });
        Object.assign(secondSession.session, {
            createdAt: 100,
            updatedAt: 100,
            meaningfulActivityAt: 610_000,
        });

        const result = sortSessionListViewItemsByOrderingMode(source, 'updated');

        expect(result.map((item) => (item.type === 'session' ? item.session.id : item.type))).toEqual([
            'header',
            'newer-bucket',
            'older-bucket',
        ]);
    });

    it('reuses the same reordered array for repeated sorting of the same source and mode', () => {
        const firstSession = makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: 'g' });
        const secondSession = makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: 'g' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g', serverId: 's1' },
            firstSession,
            secondSession,
        ];
        Object.assign(firstSession.session, { createdAt: 10, updatedAt: 10, meaningfulActivityAt: 100 });
        Object.assign(secondSession.session, { createdAt: 20, updatedAt: 20, meaningfulActivityAt: 650_000 });

        const first = sortSessionListViewItemsByOrderingMode(source, 'updated');
        const second = sortSessionListViewItemsByOrderingMode(source, 'updated');

        expect(first).toBe(second);
        expect(first).not.toBe(source);
        expect(first.map((item) => (item.type === 'session' ? item.session.id : item.type))).toEqual([
            'header',
            'b',
            'a',
        ]);
    });

    it('preserves unseen session keys when the ordered group is in the current window', () => {
        const g = 'server:s1:day:2026-02-17';
        const sessionKey = sessionAddressKey({ serverId: 's1', sessionId: 'a' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {
                [g]: [sessionKey, sessionAddressKey({ serverId: 's1', sessionId: 'missing' })],
            },
        });

        expect(normalized).toEqual({ [g]: [sessionKey, sessionAddressKey({ serverId: 's1', sessionId: 'missing' })] });
    });

    it('preserves saved folder keys even when the current window omits their rows', () => {
        const rootFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:root';
        const planningFolderGroupKey = 'folder:s1:workspaceScope:s1:m1:/repo:planning';
        const rootSessionKey = sessionAddressKey({ serverId: 's1', sessionId: 'root' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Repo', headerKind: 'project', groupKey: 'server:s1:project:repo', serverId: 's1' },
            {
                type: 'header',
                title: 'Planning',
                headerKind: 'folder',
                groupKey: planningFolderGroupKey,
                folderId: 'planning',
                folderDepth: 0,
                serverId: 's1',
            },
            makeSessionItem({ serverId: 's1', sessionId: 'root', groupKey: rootFolderGroupKey }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {
                [rootFolderGroupKey]: [rootSessionKey, folderOrderKey('planning'), folderOrderKey('missing')],
            },
        });

        expect(normalized).toEqual({
            [rootFolderGroupKey]: [rootSessionKey, folderOrderKey('planning'), folderOrderKey('missing')],
        });
    });

    it('returns the original map when group order is already normalized for the source', () => {
        const g = 'server:s1:day:2026-02-17';
        const normalizedOrder = {
            [g]: [
                sessionAddressKey({ serverId: 's1', sessionId: 'a' }),
                sessionAddressKey({ serverId: 's1', sessionId: 'b' }),
            ],
        };
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
            makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: g }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: normalizedOrder,
        });

        expect(normalized).toBe(normalizedOrder);
    });

    it('reuses already-normalized group arrays when other entries still need normalization', () => {
        const g = 'server:s1:day:2026-02-17';
        const normalizedKeys = [
            sessionAddressKey({ serverId: 's1', sessionId: 'a' }),
            sessionAddressKey({ serverId: 's1', sessionId: 'b' }),
        ];
        const groupOrder = {
            [g]: normalizedKeys,
            '   ': [` ${sessionAddressKey({ serverId: 's1', sessionId: 'c' })} `],
        };
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
            makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: g }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: groupOrder,
        });

        expect(normalized).not.toBe(groupOrder);
        expect(normalized[g]).toBe(normalizedKeys);
        expect(normalized).toEqual({ [g]: normalizedKeys });
    });

    it('reuses the same normalized group order object for repeated normalization of the same source and inputs', () => {
        const g = 'server:s1:day:2026-02-17';
        const aKey = sessionAddressKey({ serverId: 's1', sessionId: 'a' });
        const bKey = sessionAddressKey({ serverId: 's1', sessionId: 'b' });
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
            makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: g }),
        ];
        const pinnedSessionKeysV1: string[] = [];
        const groupOrder = {
            [g]: [` ${bKey} `, aKey, sessionAddressKey({ serverId: 's1', sessionId: 'missing' })],
        };

        const first = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1: groupOrder,
        });
        const second = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1: groupOrder,
        });

        expect(first).toBe(second);
        expect(first).toEqual({ [g]: [bKey, aKey, sessionAddressKey({ serverId: 's1', sessionId: 'missing' })] });
    });

    it.each(['source', 'index'] as const)('preserves unseen ordinary rows, empty scopes and identity through %s normalization', (kind) => {
        const g = 'visible-group';
        const visible = sessionAddressKey({ serverId: 's1', sessionId: 'visible' });
        const unseen = sessionAddressKey({ serverId: 's1', sessionId: 'unseen' });
        const offWindow = sessionAddressKey({ serverId: 's1', sessionId: 'off-window' });
        const order = { [g]: [unseen, visible], 'off-window-group': [offWindow], 'empty-group': [] };
        const pinnedSessionKeysV1: string[] = [];
        const normalize = (sessionListGroupOrderV1: Record<string, string[]>) => kind === 'source'
            ? normalizeSessionListGroupOrderV1ForSource({
                source: [makeSessionItem({ serverId: 's1', sessionId: 'visible', groupKey: g })],
                pinnedSessionKeysV1, sessionListGroupOrderV1,
            })
            : normalizeSessionListGroupOrderV1ForIndexSource({
                source: [{ type: 'session', serverId: 's1', sessionId: 'visible', groupKey: g, groupKind: 'project' }],
                pinnedSessionKeysV1, sessionListGroupOrderV1,
            });

        expect(normalize(order)).toBe(order);
        const needsNormalization = { ...order, [g]: [` ${unseen} `, visible, unseen], [PINNED_GROUP_KEY_V1]: [visible] };
        const normalized = normalize(needsNormalization);
        expect(normalized).toEqual(order);
        expect(normalized['off-window-group']).toBe(order['off-window-group']);
        expect(normalize(normalized)).toBe(normalized);
    });

    it('reuses a shared empty map when normalization removes all group order entries', () => {
        const source: SessionListViewItem[] = [];

        const firstNormalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
        });
        const secondNormalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
        });

        expect(firstNormalized).toBe(secondNormalized);
        expect(firstNormalized).toEqual({});
    });

    it('returns the shared empty map without scanning the source when both pinned keys and group order are empty', () => {
        const source = [
            {
                type: 'session' as const,
                get groupKey() {
                    throw new Error('source should not be inspected');
                },
                get serverId() {
                    throw new Error('source should not be inspected');
                },
                get session() {
                    throw new Error('source should not be inspected');
                },
            },
        ] as unknown as SessionListViewItem[];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
        });
        const secondNormalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
        });

        expect(normalized).toEqual({});
        expect(normalized).toBe(secondNormalized);
    });

    it('preserves custom order for every valid sibling beyond the former 100-item cap', () => {
        const g = 'server:s1:active';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Active', headerKind: 'active', groupKey: g, serverId: 's1' },
        ];
        for (let i = 0; i < 111; i++) {
            source.push(makeSessionItem({ serverId: 's1', sessionId: `s${i}`, groupKey: g }));
        }

        const order = source
            .filter((i): i is Extract<SessionListViewItem, { type: 'session' }> => i.type === 'session')
            .map((i) => sessionAddressKey({ serverId: 's1', sessionId: i.session.id }));

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: { [g]: order },
        });

        expect(normalized[g]).toHaveLength(111);
        expect(normalized[g][0]).toBe(sessionAddressKey({ serverId: 's1', sessionId: 's0' }));
        expect(normalized[g][110]).toBe(sessionAddressKey({ serverId: 's1', sessionId: 's110' }));
    });

    it('workspace normalization requires a qualified matching Home before completing Project identity', () => {
        const serverId = 'home-a';
        const scope = buildSessionWorkspaceOrderScopeKey(serverId);
        const fallback = sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity(serverId, {
            machineId: 'machine-a', pathKey: '/repo',
        }));
        const savedOrder = { [scope]: [fallback] };
        const withoutAcceptedIdentity = normalizeSessionWorkspaceOrderV1ForSource({ source: [], sessionWorkspaceOrderV1: savedOrder });
        const source = (workspaceServerId: string | null): SessionListIndexItem[] => [{
            type: 'session', serverId, sessionId: 'session-a', projectKey: { serverId, projectKey: 'accepted-project' },
            workspace: { t: 'workspaceScope', serverId: workspaceServerId, machineId: 'machine-a', rootPath: '/repo' },
        }];
        for (const workspaceServerId of [null, '', 'foreign-home']) {
            expect(normalizeSessionWorkspaceOrderV1ForSource({ source: source(workspaceServerId), sessionWorkspaceOrderV1: savedOrder }))
                .toEqual(withoutAcceptedIdentity);
        }
        expect(normalizeSessionWorkspaceOrderV1ForSource({ source: source(serverId), sessionWorkspaceOrderV1: savedOrder }))
            .toEqual({ [scope]: [JSON.stringify(['project', serverId, 'accepted-project'])] });
    });

    it('preserves custom workspace order beyond the former 100-item cap', () => {
        const serverId = 's1';
        const scopeKey = buildSessionWorkspaceOrderScopeKey(serverId);
        const workspaceKeys = Array.from({ length: 111 }, (_, index) => `/repo-${index}`);
        const itemKeys = workspaceKeys.map((workspaceKey) => buildSessionWorkspaceOrderItemKey(workspaceKey)!);
        const source: SessionListViewItem[] = workspaceKeys.map((workspaceKey, index) => ({
            type: 'header',
            title: `Repo ${index}`,
            headerKind: 'project',
            groupKey: `server:${serverId}:project:${index}`,
            serverId,
            workspaceKey,
        }));

        const normalized = normalizeSessionWorkspaceOrderV1ForSource({
            source,
            sessionWorkspaceOrderV1: { [scopeKey]: itemKeys },
        });

        expect(normalized[scopeKey]).toHaveLength(111);
        expect(normalized[scopeKey]?.[0]).toBe('/repo-0');
        expect(normalized[scopeKey]?.[110]).toBe('/repo-110');
    });

    it('keeps exact tuple identities independent during in-memory reordering', () => {
        const serverId = 'home-a';
        const identityA = sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity(serverId, {
            machineId: 'm29645',
            pathKey: '/repo',
        }));
        const identityB = sessionProjectGroupingIdentityKey(buildSessionProjectGroupingIdentity(serverId, {
            machineId: 'm41845',
            pathKey: '/repo',
        }));
        const groupA = identityA;
        const groupB = identityB;
        const source = [
            { type: 'header', title: 'A', headerKind: 'project', groupKey: groupA, workspaceKey: identityA, serverId },
            { type: 'session', sessionId: 'a', groupKey: groupA, groupKind: 'project', serverId },
            { type: 'header', title: 'B', headerKind: 'project', groupKey: groupB, workspaceKey: identityB, serverId },
            { type: 'session', sessionId: 'b', groupKey: groupB, groupKind: 'project', serverId },
        ] satisfies SessionListIndexItem[];

        const reordered = applySessionWorkspaceOrderV1ToIndex(source, {
            [buildSessionWorkspaceOrderScopeKey(serverId)]: [
                buildSessionWorkspaceOrderItemKey(identityB)!,
                buildSessionWorkspaceOrderItemKey(identityA)!,
            ],
        });

        expect(reordered.map((item) => item.type === 'header' ? item.title : item.type === 'session' ? item.sessionId : `run:${item.runId}`)).toEqual([
            'B', 'b', 'A', 'a',
        ]);
    });

    it('prunes pinned group ordering keys to only pinned sessions that exist in the source', () => {
        const g = 'server:s1:day:2026-02-17';
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: g, serverId: 's1' },
            makeSessionItem({ serverId: 's1', sessionId: 'a', groupKey: g }),
            makeSessionItem({ serverId: 's1', sessionId: 'b', groupKey: g }),
        ];

        const normalized = normalizeSessionListGroupOrderV1ForSource({
            source,
            pinnedSessionKeysV1: ['s1:a'],
            sessionListGroupOrderV1: { [PINNED_GROUP_KEY_V1]: ['s1:b', 's1:a', 's1:missing'] },
        });

        expect(normalized).toEqual({ [PINNED_GROUP_KEY_V1]: ['s1:a'] });
    });
});
