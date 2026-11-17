import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, renderHook } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createArtifactStoreBoundary, createArtifactBodyUpdateFixture, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { useDispatchWorkBoardIntent, useWorkBoard, useWorkBoards, useWorkBoardSummaries } from './useWorkBoards';
import { storage } from '@/sync/domains/state/storage';
import { buildWorkBoardArtifactHeaderV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { createWorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import type { Socket } from 'socket.io-client';
import { configureConnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const requests: string[] = [];
let pendingList: Readonly<{ started: () => void; response: Promise<void> }> | null = null;
const homeSockets: Socket[] = [];
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
// Real Account, Artifact store, sync and Action owners run; only the Home HTTP boundary is observed.
const runtime = installSessionPaneRuntimeTestHarness({
    configureSocket: socket => {
        homeSockets.push(socket);
        configureConnectedServerSocketBoundary(socket);
    },
    request: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/v1/artifacts' && pendingList) {
            const pending = pendingList;
            pendingList = null;
            pending.started();
            await pending.response;
        }
        return await artifacts.handle(`${url.pathname}${url.search}`, init);
    },
});

describe('Board body reads', () => {
    it.each([{ count: 1, opened: true }, { count: 8, opened: true }, { count: 8, opened: false }])(
        'reads only demanded bodies with $count Board headers (opened: $opened)', async ({ count, opened }) => {
        artifacts.clear();
        const boards = Array.from({ length: count }, (_, index) => createWorkBoardV1({
            id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`, name: `Board ${index + 1}`,
        }));
        const executor = createDefaultActionExecutor();
        for (const { id, name } of boards) expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id, name } } },
            { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true })).toMatchObject({ ok: true });
        requests.length = 0;
        const openedId = boards[count - 1]!.id;
        // These are the column's collection readers and the screen's exact reader, sharing the real Account owner.
        const hook = await renderHook(({ openedId }: { openedId: string | null }) => ({
            bodies: useWorkBoards(), summaries: useWorkBoardSummaries(), opened: useWorkBoard(openedId),
        }), { initialProps: { openedId: opened ? openedId : null }, wrapper: runtime.Wrapper });
        const bodyReads = () => requests.filter(request => /^GET \/v1\/artifacts\/[^/]+$/.test(request));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().summaries).toHaveLength(count));
            if (!opened) {
                expect(bodyReads(), `Header-only column with N=${count}`).toEqual([]);
                await hook.rerender({ openedId });
            }
            await vi.waitFor(() => expect(hook.getCurrent().opened?.id).toBe(openedId));
            expect(bodyReads(), `One open Board with N=${count}`).toEqual([`GET /v1/artifacts/${openedId}`]);
            expect(hook.getCurrent().bodies.boards.map(board => board.id)).toEqual([openedId]);
            expect(requests.filter(request => request.endsWith('/access/grants'))).toHaveLength(1);
            if (count > 1) {
                requests.length = 0;
                const nextId = boards[0]!.id;
                await hook.rerender({ openedId: nextId });
                await vi.waitFor(() => expect(hook.getCurrent().opened?.id).toBe(nextId));
                expect(bodyReads()).toEqual([`GET /v1/artifacts/${nextId}`]);
                expect(requests.filter(request => request === 'GET /v1/artifacts')).toEqual([]);
            }
        } finally { await hook.unmount(); }
    });

    it('consumes exact pushed revisions without re-listing headers or reading neighbours', async () => {
        const id = '22222222-2222-4222-8222-222222222223';
        const executor = createDefaultActionExecutor();
        const context = { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true } as const;
        expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id, name: 'Before push' } } }, context))
            .toMatchObject({ ok: true });
        const hook = await renderHook(() => ({ board: useWorkBoard(id), summaries: useWorkBoardSummaries() }), { wrapper: runtime.Wrapper });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().board?.name).toBe('Before push'));
            const oldBoard = hook.getCurrent().board!;
            const current = storage.getState().artifacts[id]!;
            expect(current).toBeDefined();
            if (!current.isDecrypted) throw new Error('The created Board must be readable');
            requests.length = 0;
            for (let index = 0; index < 3; index++) await act(async () => {
                storage.getState().applyArtifacts([{ ...current, id: 'unrelated', header: { kind: 'note', title: 'Note' },
                    rawHeader: { kind: 'note', title: 'Note' }, headerVersion: index + 1 }]);
            });
            expect(requests).toEqual([]);
            const board = { ...oldBoard, name: 'After push', pinnedInSessions: true };
            const header = buildWorkBoardArtifactHeaderV1(board);
            const committed = createPlainArtifactHttpFixture({ ...current, header: { ...header, title: board.name }, rawHeader: header,
                body: JSON.stringify(board), headerVersion: current.headerVersion + 1, bodyVersion: (current.bodyVersion ?? 1) + 1 }, 'account-a');
            artifacts.replaceStoredRow(committed);
            const bodyUpdate = createArtifactBodyUpdateFixture(committed, 1);
            const update = UpdateContainerSchema.parse({ ...bodyUpdate, body: { ...bodyUpdate.body,
                header: { value: committed.header, version: committed.headerVersion } } });
            await act(async () => {
                // RPC pool sockets share this boundary but do not consume Account pushes.
                const pushSockets = homeSockets.filter(socket => socket.connected && socket.listenersAny().length > 0);
                expect(pushSockets).toHaveLength(1);
                const listeners = pushSockets[0]!.listenersAny();
                await Promise.all(listeners.map(listener => listener('update', update)));
            });
            await vi.waitFor(() => expect(hook.getCurrent().board?.name).toBe('After push'));
            expect(hook.getCurrent().summaries.find(summary => summary.id === id)).toMatchObject({ name: 'After push', pinnedInSessions: true });
            expect(requests.filter(request => request === 'GET /v1/artifacts')).toEqual([]);
            expect(requests.filter(request => request === `GET /v1/artifacts/${id}`)).toHaveLength(1);
            const acknowledged = hook.getCurrent().board;
            requests.length = 0;
            await act(async () => { storage.getState().applyArtifacts([{ ...storage.getState().artifacts[id]! }]); });
            expect(requests).toEqual([]);
            expect(hook.getCurrent().board).toBe(acknowledged);
        } finally { await hook.unmount(); }
    });
    it('does not start Board bodies when the last view closes before its inventory returns', async () => {
        const executor = createDefaultActionExecutor();
        const created = await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222221', name: 'Closed Board' } } },
            { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true });
        expect(created).toMatchObject({ ok: true });
        requests.length = 0;
        const started = createDeferred<void>();
        const response = createDeferred<void>();
        pendingList = { started: () => started.resolve(), response: response.promise };
        const hook = await renderHook(() => useWorkBoard('22222222-2222-4222-8222-222222222221'), { wrapper: runtime.Wrapper });
        let mounted = true;
        try {
            await started.promise;
            await hook.unmount();
            mounted = false;
            await act(async () => { response.resolve(); });
            expect(requests.filter(request => request.startsWith('GET /v1/artifacts/'))).toEqual([]);
        } finally {
            pendingList = null;
            response.resolve();
            if (mounted) await hook.unmount();
        }
    });

    it('reads a mounted Board once and stays quiet while nothing changes', async () => {
        const executor = createDefaultActionExecutor();
        const context = { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true } as const;
        const created = await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222222', name: 'My Board' } } }, context);
        expect(created, JSON.stringify(created) + ' ' + requests.join(' | ')).toMatchObject({ ok: true });
        requests.length = 0;

        const hook = await renderHook(() => useWorkBoard('22222222-2222-4222-8222-222222222222'), { wrapper: runtime.Wrapper });
        await vi.waitFor(() => expect(hook.getCurrent()?.id).toBe('22222222-2222-4222-8222-222222222222'));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 1500)); });

        // The Board's audience is still read, but as part of that one read, not by reopening the Artifact.
        expect(requests.filter(request => request === 'GET /v1/artifacts/22222222-2222-4222-8222-222222222222'), requests.join(' | ')).toHaveLength(1);
        expect(requests.filter(request => request === 'GET /v1/artifacts/22222222-2222-4222-8222-222222222222/access/grants')).toHaveLength(1);
    });

    it('reads nothing on a socket reconnect while the mounted Board read is current', async () => {
        const executor = createDefaultActionExecutor();
        const context = { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true } as const;
        const id = '44444444-4444-4444-8444-444444444444';
        expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id, name: 'Reconnect Board' } } }, context)).toMatchObject({ ok: true });
        const hook = await renderHook(() => useWorkBoard(id), { wrapper: runtime.Wrapper });
        try {
            await vi.waitFor(() => expect(hook.getCurrent()?.id).toBe(id));
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
            const socket = homeSockets.at(-1);
            if (!socket) throw new Error('Expected the Home Account transport');
            requests.length = 0;
            // Board changes made while the socket was down reach `storage.artifacts` through the changes catch-up.
            await act(async () => {
                socket.connected = false;
                for (const listener of socket.listeners('disconnect')) listener('transport close');
                socket.connected = true;
                for (const listener of socket.listeners('connect')) listener();
                await new Promise(resolve => setTimeout(resolve, 1000));
            });
            expect(requests.filter(request => request.startsWith('GET /v1/artifacts')), requests.join(' | ')).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it('switches an open Board layout with one validated read and one write, and reads nothing back', async () => {
        const id = '22222222-2222-4222-8222-222222222224';
        const executor = createDefaultActionExecutor();
        const context = { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true } as const;
        expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id, name: 'Layout Board' } } }, context))
            .toMatchObject({ ok: true });
        const hook = await renderHook(() => ({ board: useWorkBoard(id), dispatch: useDispatchWorkBoardIntent() }), { wrapper: runtime.Wrapper });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().board?.mode).toBe('canvas'));
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
            requests.length = 0;
            // One layout switch, as the header's Canvas | By status control dispatches it.
            await act(async () => {
                expect(await hook.getCurrent().dispatch({ kind: 'update', boardId: id, patch: { mode: 'by_status' } }))
                    .toMatchObject({ status: 'applied' });
            });
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 1500)); });
            expect(hook.getCurrent().board?.mode).toBe('by_status');
            const exact = `/v1/artifacts/${id}`;
            const reads = requests.filter(request => request === `GET ${exact}` || request === 'POST /v1/artifacts/read');
            const grants = requests.filter(request => request === `GET ${exact}/access/grants`);
            const writes = requests.filter(request => request === `POST ${exact}`);
            // The CAS write is validated against exactly one read of the Board (with its audience);
            // its own acknowledged revision is not read back.
            expect({ reads: reads.length, grants: grants.length, writes: writes.length }, requests.join(' | '))
                .toEqual({ reads: 1, grants: 1, writes: 1 });
        } finally { await hook.unmount(); }
    });
});
