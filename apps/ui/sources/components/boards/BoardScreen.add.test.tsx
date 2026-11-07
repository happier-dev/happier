/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { buildWorkBoardArtifactHeaderV1} from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { buildWorkBoardItemKeyV1, createWorkBoardV1, type WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { BoardScreen } from './BoardScreen';

vi.mock('react-native', async () => ({
    ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/boards/qa43-board' }).module);

// The Account fixture's real readiness graph belongs to collection, not a UI interaction deadline.
await import('@/sync/syncEngine');
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let restoreBrowserLocks: ReturnType<typeof installBrowserStorageLockBoundary>;
beforeEach(() => { restoreBrowserLocks = installBrowserStorageLockBoundary(); });
afterEach(async () => {
    try { await standardCleanup(); await home?.dispose(); }
    finally { home = undefined; restoreBrowserLocks(); }
});

async function mountBoard(source?: WorkBoardV1['source'], prepare?: (serverId: string) => void,
    handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>) {
    // This fixture admits an Account directly instead of starting unrelated cold Sync
    // acquisitions. All Board reads, codecs, navigation and overlay owners remain real.
    home = await createPlainArtifactHomeFixture('https://board-phone.test', { accountId: 'owner', ...(handleRequest ? { handleRequest } : {}) });
    prepare?.(home.home.id);
    const board: WorkBoardV1 = { ...createWorkBoardV1({ id: 'qa43-board', name: 'QA43 Board' }), ...(source ? { source } : {}) };
    home.boundary.replaceStoredRow({
        id: board.id, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
    });
    const credentials = await TokenStorage.getCredentialsForServerUrl(home.home.serverUrl);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const find = (testID: string) => document.querySelector<HTMLElement>(`[data-testid=${JSON.stringify(testID)}]`);
    const expectReady = (testID: string, present = true) => waitForHomeGovernance(async () => {
        await act(async () => {});
        if (present) expect(find(testID), document.body.textContent).not.toBeNull();
        else expect(find(testID), document.body.textContent).toBeNull();
    });
    const press = async (testID: string) => { await act(async () => { find(testID)!.click(); }); };
    const navigation = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
    await act(async () => root.render(<InjectedAuthProvider credentials={credentials}>
        <DestinationInstanceHost tabId="board" ref={{ kind: 'boards', params: { id: board.id } }}
            pathname={`/boards/${board.id}`} focused visible phone
            navigation={navigation}>
            <BoardScreen boardId={board.id} />
        </DestinationInstanceHost>
    </InjectedAuthProvider>));
    return { serverId: home.home.id, find, expectReady, press, navigation, dispose: async () => { await act(async () => root.unmount()); container.remove(); } };
}

describe('Board phone Add entry points', () => {
    it('shows the board page with its header while the board itself is still being read, never a blank page', async () => {
        // The network boundary: the Home's Artifact reads wait.
        let release: () => void = () => undefined;
        const held = new Promise<void>(resolve => { release = resolve; });
        const { find, expectReady, dispose } = await mountBoard(undefined, undefined, async (path) => {
            if (path.startsWith('/v1/artifacts')) await held;
            return null;
        });
        try {
            await expectReady('board-opening');
            expect(find('board-header')).not.toBeNull();
            expect(find('board-pending')).not.toBeNull();
            release();
            await expectReady('board-empty');
            expect(find('board-opening')).toBeNull();
        } finally { release(); await dispose(); }
    });
    it('opens a Workflow card on the Home named by its qualified target', async () => {
        const ref = { kind: 'workflow' as const, qualifiedId: { serverId: 'https://board-phone.test', id: 'workflow-home-test' } };
        const { expectReady, press, navigation, dispose } = await mountBoard({ picked: [ref], sections: [] }, serverId => {
            ref.qualifiedId.serverId = serverId;
        });
        try {
            const testID = `board-status-card:${buildWorkBoardItemKeyV1(ref)}`;
            await expectReady(testID);
            await press(testID);
            expect(navigation.push).toHaveBeenCalledWith({ pathname: '/workflows/[id]', params: {
                id: ref.qualifiedId.id, serverId: ref.qualifiedId.serverId,
            } });
        } finally { await dispose(); }
    });
    it('keeps the canvas total quiet while a selected source is still answering, even with an explicit pick', async () => {
        const serverId = 'https://board-phone.test';
        const { find, expectReady, dispose, serverId: admittedServerId } = await mountBoard({
            picked: [{ kind: 'machine', qualifiedId: { serverId, id: 'picked-machine' } }], sections: ['my_machines'],
        }, serverId => storage.setState({ machineListByServerId: { [serverId]: null }, machineListStatusByServerId: { [serverId]: 'loading' } }));
        try {
            await expectReady('board-header');
            expect(find('board-header')?.textContent).not.toMatch(/\d+ items?/);
            await act(async () => storage.setState({ machineListByServerId: { [admittedServerId]: [] },
                machineListStatusByServerId: { [admittedServerId]: 'idle' } }));
            await waitForHomeGovernance(async () => {
                await act(async () => {});
                expect(find('board-header')?.textContent).toMatch(/1 item/);
            });
        } finally { await dispose(); }
    });
    it('opens one Add surface from the empty CTA and again from the navigation overflow', async () => {
        const { find, expectReady, press, dispose } = await mountBoard();
        try {
        await expectReady('board-empty');
        // The empty state says the board is empty; the header meta does not say it again.
        expect(find('board-header')?.textContent ?? '').not.toMatch(/Nothing here yet|addedByHandNone/);
        expect(find('board-header.source')).not.toBeNull();
        expect(find('board-header.add')).toBeNull();
        await press('board-empty.add');
        await expectReady('board-add.popover');
        expect(document.querySelectorAll('[data-testid="board-add.popover"]')).toHaveLength(1);
        await press('popover-sheet.close');
        await expectReady('board-add.popover', false);
        await press('page-header-actions.trigger');
        await expectReady('board-header.add');
        await press('board-header.add');
        await expectReady('board-add.popover');
        expect(document.querySelectorAll('[data-testid="board-add.popover"]')).toHaveLength(1);
        } finally {
            await dispose();
        }
    });

    it('invites adding to a board whose source has answered and matches nothing, rather than leaving a bare canvas', async () => {
        const { find, expectReady, press, dispose } = await mountBoard({ picked: [], sections: ['my_machines'] }, serverId => {
            storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
        });
        try {
            await expectReady('board-empty');
            expect(find('board-header.source')).not.toBeNull();
            await press('board-empty.add');
            await expectReady('board-add.popover');
        } finally {
            await dispose();
        }
    });

    it.each([false, true])('keeps the canvas until Machines answer (with items: %s)', async withItems => {
        const { serverId, find, expectReady, dispose } = await mountBoard({ picked: [], sections: ['my_machines'] }, serverId => {
            storage.setState({ machineListByServerId: { [serverId]: null }, machineListStatusByServerId: { [serverId]: 'loading' } });
        });
        try {
            await expectReady('board-header');
            expect(find('board-empty')).toBeNull();
            expect(find('board-by-status')).not.toBeNull();
            // The unanswered source says so quietly inside the canvas: neither empty nor a bare surface.
            expect(find('board-pending')).not.toBeNull();
            const machine = createMachineFixture({ id: 'fx124-machine' });
            await act(async () => storage.setState({
                machineListByServerId: { [serverId]: withItems ? [machine] : [] },
                machineListStatusByServerId: { [serverId]: 'idle' },
            }));
            await expectReady('board-empty', !withItems);
            expect(find('board-pending')).toBeNull();
            if (withItems) await waitForHomeGovernance(async () => {
                await act(async () => {});
                expect(document.querySelector('[data-testid^="board-status-card:"]')).not.toBeNull();
            });
        } finally {
            await dispose();
        }
    });
});
