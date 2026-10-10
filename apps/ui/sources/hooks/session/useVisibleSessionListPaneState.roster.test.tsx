import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema, CurrentCursorResponseSchema } from '@happier-dev/protocol';
import { SessionListQueryV1Schema, type SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';

import { createPlainAccountEncryptionCurrentnessFixture, createRootLayoutFeaturesResponse, createSessionListRenderableSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListQueryKey } from '@/sync/domains/session/listing/sessionListQueryKey';

// The Account, ordinary list/index, Bot classification and presentation stay
// real. Only native/navigation adapters and the external transports are replaced.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installDisconnectedServerSocketBoundary(socket => {
    socket.connect = vi.fn(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});

const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, filteredListing: { enabled: true } } } });
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let queryRequests: SessionListQueryV1[] = [];
const nextCursor = encodeV2SessionListCursorV1('page-one');

function renderedSessionIds(index: readonly SessionListIndexItem[] | null) {
    return index?.filter(item => item.type === 'session').map(item => item.sessionId) ?? [];
}

describe('ordinary list presentation for the opened Bots roster', () => {
    beforeAll(loadSyncSingletonForTests);
    beforeEach(async () => {
        queryRequests = [];
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://bots-roster-presentation.example.test',
            serverIdentityId: 'srv_bots-roster-presentation', accountId: 'account-a',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v2/sessions/query') {
                    const query = SessionListQueryV1Schema.parse(JSON.parse(String(init?.body)));
                    queryRequests.push(query);
                    const lastPage = query.cursor === nextCursor;
                    return Response.json(SessionListQueryResponseV1Schema.parse({
                        sessions: [], nextCursor: lastPage ? null : nextCursor, hasNext: !lastPage,
                        attentionNextCursor: null, attentionHasNext: false,
                        ...(lastPage ? { metadataUpgradeRequiredCount: 1 } : {}),
                    }));
                }
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v1/features') return Response.json(features);
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
                    content: { t: 'plain', v: { hideInactiveSessions: true } }, version: 1,
                }));
                return new Response('{}', { status: 404 });
            },
        });
        const serverId = connection.home.id;
        const now = Date.now();
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        storage.getState().applySettingsLocal({ hideInactiveSessions: true });
        storage.getState().applyServerScopedSessionListRows(serverId, [
            createSessionListRenderableSessionFixture({ id: 'inactive-bot', active: false,
                metadata: { path: '/project', bot: { kind: 'bot' } } }),
            createSessionListRenderableSessionFixture({ id: 'active-bot', active: true, activeAt: now, updatedAt: now,
                metadata: { path: '/project', bot: { kind: 'bot' } } }),
            createSessionListRenderableSessionFixture({ id: 'ordinary', active: true, activeAt: now, updatedAt: now,
                metadata: { path: '/project' } }),
        ], { source: 'ordinary', mode: 'replace' });
    });
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        connection = undefined;
    });

    it('selects only Bots including inactive ones without changing the Account list preference or ordinary default', async () => {
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const ordinary = await renderHook(() => useVisibleSessionListPaneState('all'));
        expect(renderedSessionIds(ordinary.getCurrent().visibleSessionListIndex).sort()).toEqual(['active-bot', 'ordinary']);

        const rosterOptions = { botsRoster: true as const };
        const roster = await renderHook(() => useVisibleSessionListPaneState('all', rosterOptions));
        expect(renderedSessionIds(roster.getCurrent().visibleSessionListIndex).sort()).toEqual(['active-bot', 'inactive-bot']);
        expect(storage.getState().settings.hideInactiveSessions).toBe(true);
        expect(renderedSessionIds(ordinary.getCurrent().visibleSessionListIndex).sort()).toEqual(['active-bot', 'ordinary']);
    });

    it('keeps the ordinary query cursor and truthful incomplete metadata coverage without publishing roster membership', async () => {
        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListPaneState');
        const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
        const query: SessionListQueryV1 = { v: 1, storage: 'active', includeInactive: false,
            scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [] };
        const queryHomes = [{ serverId, query }];
        const ordinaryQueryKey = buildSessionListQueryKey(serverId, { ...query, includeInactive: true });
        storage.getState().commitSessionListQueryMembership(ordinaryQueryKey, {
            serverId, accountId: 'account-a', sessionIds: ['ordinary'],
        });
        const memberships = storage.getState().sessionListQueryMembershipByKey;
        const roster = await renderHook(() => useVisibleSessionListPaneState('all', { botsRoster: true, queryHomes }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(roster.getCurrent().query?.statesByServerId[serverId]?.phase, JSON.stringify({
                states: roster.getCurrent().query?.statesByServerId,
                active: roster.getCurrent().query?.active,
                presentation: roster.getCurrent().queryPresentation,
                socketStatus: storage.getState().socketStatus,
                queryRequests,
            })).toBe('ready');
        });
        expect(queryRequests).toEqual([expect.objectContaining({ includeInactive: true, scope: 'all_accessible' })]);
        expect(queryRequests[0]?.bot).toBeUndefined();
        expect(roster.getCurrent().query?.statesByServerId[serverId]).toMatchObject({ hasNext: true, nextCursor });
        expect(roster.getCurrent().query?.coverageComplete).toBe(false);
        expect(storage.getState().sessionListQueryMembershipByKey).toEqual(memberships);

        await roster.getCurrent().query?.loadNext();
        await flushHookEffects();
        expect(queryRequests[1]).toMatchObject({ includeInactive: true, cursor: nextCursor });
        expect(roster.getCurrent().query?.statesByServerId[serverId]).toMatchObject({
            hasNext: false, nextCursor: null, metadataUpgradeRequiredCount: 1,
        });
        expect(roster.getCurrent().query?.coverageComplete).toBe(false);
        expect(storage.getState().sessionListQueryMembershipByKey).toEqual(memberships);
    });
});
