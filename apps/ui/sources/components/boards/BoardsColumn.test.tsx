import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, buildWorkBoardArtifactHeaderV1, createWorkBoardV1, encodePlainArtifactStoredContent, type WorkBoardV1 } from '@happier-dev/protocol';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { createPlainAccountEncryptionCurrentnessFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { BoardsColumn } from './BoardsColumn';
import { BoardScreen } from './BoardScreen';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PinnedBoardNeedsYouCount } from './PinnedBoardNeedsYouCount';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { act } from 'react-test-renderer';

// Native and navigation adapters are external boundaries; the Board store and collection stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/boards/alpha' }).module;
});
// The applied connection is a network/environment boundary. Keep Account lifetime and readers real,
// as in workflowLibraryReads.test.tsx, while declaring this HTTP fixture's Home connected.
vi.mock('@/sync/runtime/orchestration/connectionManager', async importOriginal => {
    const actual = await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>();
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    return { ...actual, getAppliedActiveServerSnapshot: () => getActiveServerSnapshot(), isAppliedActiveServerRuntimeAvailable: () => true };
});

const boards = [createWorkBoardV1({ id: 'alpha', name: 'Alpha release' }), createWorkBoardV1({ id: 'beta', name: 'Beta work' })];
const artifacts = boards.map(board => ({
    id: board.id, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
}));
let home: Awaited<ReturnType<typeof serveActionHomes>> | null = null;
let credentials: AuthCredentials | null = null;
let unreadableAlpha: 'malformed_json' | 'content_unavailable' | null = null;
let liveBoard: WorkBoardV1 | null = null;
let previousStorageState = getStorage().getState();

describe('BoardsColumn collection search', () => {
    beforeEach(async () => {
        previousStorageState = getStorage().getState();
        unreadableAlpha = null;
        liveBoard = null;
        home = await serveActionHomes({
            homes: [{ key: 'boards', serverUrl: 'https://boards-column.test', accountId: 'owner' }],
            route: request => {
                if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                const rows = artifacts.map(artifact => liveBoard && artifact.id === liveBoard.id ? {
                    ...artifact, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(liveBoard)),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(liveBoard) }),
                } : artifact);
                if (request.path === '/v1/artifacts') return Response.json(rows);
                const artifact = rows.find(row => request.path === `/v1/artifacts/${row.id}`);
                if (artifact?.id === 'alpha' && unreadableAlpha) return Response.json({ ...artifact,
                    body: encodePlainArtifactStoredContent(unreadableAlpha === 'malformed_json'
                        ? { body: '{ invalid Board JSON' } : { body: 42 }),
                });
                return artifact ? Response.json(artifact) : undefined;
            },
        });
        // The HTTP helper selects a browser tab; this node renderer has no sessionStorage.
        // Establish the same real device selection that workflowLibraryReads' fixture uses.
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        await setActiveServer({ serverId: home.homes.boards!.id, scope: 'device' });
        credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.boards!.serverUrl);
        const scope = { serverId: home.homes.boards!.id, accountId: 'owner' };
        getStorage().setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        vi.useFakeTimers();
    });
    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        home?.dispose();
        home = null;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(previousStorageState);
        vi.restoreAllMocks();
    });

    it('filters real acknowledged Board names while keeping one stable creation row', async () => {
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn /></InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull();
        expect(screen.findHostByTestId('boards-column:board:beta')).not.toBeNull();
        expect(screen.findHostByTestId('boards-column:search')).not.toBeNull();

        screen.changeTextByTestId('boards-column:search', '  ALPHA  ');
        await flushHookEffects();
        expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull();
        expect(screen.findHostByTestId('boards-column:board:beta')).toBeNull();
        expect(screen.findHostByTestId('boards-column:new-row')).not.toBeNull();
        expect(screen.findHostByTestId('boards-column:new')).toBeNull();

        screen.changeTextByTestId('boards-column:search', 'not a board');
        await flushHookEffects();
        expect(screen.findHostByTestId('boards-column:board:alpha')).toBeNull();
        expect(screen.findHostByTestId('boards-column:new-row')).not.toBeNull();
        screen.changeTextByTestId('boards-column:search', '');
        await flushHookEffects();
        expect(screen.findHostByTestId('boards-column:board:beta')).not.toBeNull();
    });

    it('keeps populated column and pinned chrome free of card title construction while attention stays live', async () => {
        const serverId = home!.homes.boards!.id;
        let titleReads = 0;
        const rows = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
            const row = createSessionListRenderableSessionFixture({ id: `chrome-${index}`, active: true, activeAt: Date.now(), metadata: {
                path: '/repo', host: 'test', homeDir: '/home/test',
                get name() { titleReads += 1; return `Session ${index}`; },
            } });
            return [row.id, row];
        }));
        liveBoard = { ...boards[0]!, pinnedInSessions: true, source: { picked: Object.keys(rows).map(id => ({ kind: 'session', qualifiedId: { serverId, id } })) } };
        getStorage().setState({ sessionListRowsByServerId: { [serverId]: rows } });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn />
            <PinnedBoardNeedsYouCount board={{ id: 'alpha', name: liveBoard.name, pinnedInSessions: true, source: { sections: [] } }} />
        </InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull();
        expect(titleReads).toBe(0);
        const updated = { ...rows['chrome-7']!, hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() };
        act(() => { getStorage().setState({ sessionListRowsByServerId: { [serverId]: { ...rows, [updated.id]: updated } } }); });
        expect(screen.findHostByTestId('boards-column:board:alpha:need-you')).not.toBeNull();
        expect(screen.findHostByTestId('pinned-board:alpha:need-you')).not.toBeNull();
        expect(titleReads).toBe(0);
    });

    it.each(['malformed_json', 'content_unavailable'] as const)('opens a named unreadable Board state for %s and keeps the neighboring Board reachable', async failure => {
        unreadableAlpha = failure;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <BoardsColumn /><BoardScreen boardId="alpha" />
        </InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findHostByTestId('board-unreadable')).not.toBeNull();
        expect(screen.findHostByTestId('board-not-found')).toBeNull();
        expect(screen.findHostByTestId('boards-column:board:beta')).not.toBeNull();
        const state = screen.tree.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'board-unreadable');
        expect(state?.props.title).toContain('Alpha release');
        expect(state?.props.action?.onPress).toBeTypeOf('function');
    });
});
