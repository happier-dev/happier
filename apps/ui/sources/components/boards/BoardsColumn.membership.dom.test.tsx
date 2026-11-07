/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { buildWorkBoardArtifactHeaderV1} from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { createWorkBoardV1, type WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { normalizeSessionListFilterV1} from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/boards/retained' }).module);

it('keeps the settled rail line across navigation and shares it with a newly mounted page', async () => {
    const boundary = await createSessionListQuerySourceHarness();
    const serverId = boundary.focusedHome();
    const gate = createDeferred<void>();
    let holding = false;
    let ids = ['retained-member', 'unknown-member'];
    boundary.http.answer(serverId, '/v2/sessions/query', { select: () => ({
        body: createSessionListSourceFixture({ sessions: ids.map(id => ({
            ...createPlainSessionCurrentProjectionRecordFixture({ id, metadata: { path: '/repo', host: 'test',
                ...(id === 'unknown-member' ? {} : { branch: 'main' }) } }),
            viewer: createSessionOwnerViewerFixture(createSessionFixture({ id })),
        })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }),
        ...(holding ? { respondAfter: gate.promise } : {}),
    }) });
    const board = { ...createWorkBoardV1({ id: 'retained', name: 'Retained work' }), source: { picked: [],
        filter: normalizeSessionListFilterV1({ show: 'sessions', scope: 'all_accessible', homeServerIds: [serverId],
            branches: { include: ['main'], exclude: [] } }),
    } };
    boundary.http.artifacts(serverId).replaceStoredRow({
        id: board.id, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        ownerAccountId: boundary.accountId(serverId), access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
    } satisfies Artifact);
    // The shared source harness has completed real Home/Account restoration, ordinary
    // bootstrap and Socket connection before the rail acquires its strict query.
    const { BoardsColumn } = await import('./BoardsColumn');
    const { CollectionNavigationRow } = await import('@/components/ui/lists/collection/CollectionList');
    const { useBoardLiveCards } = await import('./model/useBoardContent');
    const { useWorkBoard } = await import('./model/useWorkBoards');
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(boundary.origin(serverId));
    let pageMembership: ReturnType<typeof useBoardLiveCards>['membership'] | null = null;
    function PageContent(props: Readonly<{ board: WorkBoardV1 }>) { pageMembership = useBoardLiveCards(props.board).membership; return null; }
    function Page() { const current = useWorkBoard(board.id); return current ? <PageContent board={current} /> : null; }
    const lines: unknown[] = [];
    let record = false;
    const onRailRender = () => { if (record) lines.push(railLine()); };
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
        <React.Profiler key="rail" id="rail" onRender={onRailRender}><BoardsColumn /></React.Profiler>
        {null}
    </InjectedAuthProvider>);
    const railLine = () => screen.findAllByType(CollectionNavigationRow).find(row => row.props.testID === 'boards-column:board:retained')?.props.subtitle;
    const update = (rail: boolean, page: boolean) => screen.update(
        <InjectedAuthProvider credentials={credentials}>
            {rail ? <React.Profiler key="rail" id="rail" onRender={onRailRender}><BoardsColumn /></React.Profiler> : null}
            {page ? <Page key="page" /> : null}
        </InjectedAuthProvider>,
    );
    const queries = () => boundary.http.requestsFor('/v2/sessions/query').filter(request => request.serverId === serverId).length;
    try {
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(railLine()).toEqual(expect.any(String)); expect(railLine()).not.toBe(''); });
        const settledLine: unknown = railLine();
        expect(queries()).toBe(1);
        await update(true, true);
        await flushHookEffects();
        expect(queries()).toBe(1);
        expect(pageMembership).toMatchObject({ settled: true, members: [expect.objectContaining({ key: expect.stringContaining('retained-member') })], undetermined: { count: 1 } });
        await update(false, false);
        holding = true;
        ids = [];
        record = true;
        await update(true, true);
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(queries()).toBe(2); });
        expect(railLine()).toBe(settledLine);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.every(line => line === settledLine)).toBe(true);
        expect(pageMembership).toMatchObject({ settled: true, complete: false, undetermined: { count: 1 } });
        record = false;
        await act(async () => { gate.resolve(); });
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(pageMembership).toMatchObject({ settled: true, complete: true, members: [], undetermined: { count: 0 } }); });
        expect(railLine()).not.toBe(settledLine);
    } finally {
        gate.resolve();
        await standardCleanup();
        await boundary.dispose();
    }
});
