import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getStorage } from '@/sync/domains/state/storage';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { buildWorkBoardItemKeyV1, WorkBoardV1Schema} from '@happier-dev/protocol/boards/workBoardV1';
import {
    WorkBoardActionOutputSchemasV1} from '@happier-dev/protocol/boards/actionsV1';
import { ArtifactBodyEnvelopeV1Schema} from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createWorkBoardAccountStore } from '@/components/boards/model/workBoardAccountStore';
import { createWorkBoardUiActionPort } from '@/components/boards/model/workBoardEntityDrop';
import { projectBoardMembership } from '@/components/boards/model/boardMembership';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

// Only HTTP, credentials and native UI modules are replaced; domain and encryption owners run.
installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary();
const initialState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => {
    await connection?.dispose(); connection = null;
    retireActiveServerAccountScopeLifetime(); resetRuntimeFetch(); invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests(); getStorage().setState(initialState, true); vi.restoreAllMocks();
});
describe('Board Actions through captured Home Artifacts', () => {
    it('rebases a Board conflict on the captured Home and deletes through the Artifact revision owner', async () => {
        const target = await upsertAndActivateServer({ serverUrl: 'https://board-target.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://board-focused.test', scope: 'tab' });
        const token = createAccountTokenForTests('board-owner', { currentAccount: true });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const first = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: target.id, id: 's1' } });
        const second = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: target.id, id: 's2' } });
        const persistence = createArtifactStoreBoundary({ ownerAccountId: () => 'board-owner', encryptionMode: 'plain' });
        const currentBoard = () => WorkBoardV1Schema.parse(JSON.parse(persistence.readPlainBody('22222222-2222-4222-8222-222222222225') ?? 'null'));
        const requests: string[] = [];
        const request: Parameters<typeof setRuntimeFetch>[0] = async (input, init) => {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://board-target.test');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            const method = init?.method ?? 'GET';
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
            requests.push(`${method} ${url.pathname}`);
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: { unrelated: 'x'.repeat(600_000) } }, version: 1 });
            return await persistence.handle(`${url.pathname}${url.search}`, init) ?? Response.json({ error: 'not_found' }, { status: 404 });
        };
        setRuntimeFetch(request);
        const executor = createDefaultActionExecutor();
        const context = { serverId: target.id, surface: 'ui', bypassApprovals: true } as const;
        expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222225', name: 'My Board' } } }, context))
            .toMatchObject({ ok: true, result: { board: { id: '22222222-2222-4222-8222-222222222225', name: 'My Board' } } });
        persistence.beforeNextUpdate(async () => {
            // A second real Action writes the winner, including revision-bound provenance.
            // Copying only its body would fabricate an unreadable provenance/version mismatch.
            expect(await executor.execute('boards.apply', { intent: { kind: 'set_positions', boardId: '22222222-2222-4222-8222-222222222225',
                positionsByItemRef: { [second]: { x: 3, y: 4 } } } }, context))
                .toMatchObject({ ok: true, result: { board: { positionsByItemRef: { [second]: { x: 3, y: 4 } } } } });
        });
        const moved = await executor.execute('boards.apply', { intent: { kind: 'set_positions', boardId: '22222222-2222-4222-8222-222222222225', positionsByItemRef: { [first]: { x: 48, y: 96 } } } }, context);
        expect(moved, JSON.stringify(moved))
            .toMatchObject({ ok: true, result: { board: { positionsByItemRef: { [first]: { x: 48, y: 96 }, [second]: { x: 3, y: 4 } } } } });
        if (!moved.ok) throw new Error(moved.error);
        const board = currentBoard();
        expect(WorkBoardActionOutputSchemasV1['boards.apply'].parse(moved.result).board).toEqual(board);
        const storedBody = persistence.read('22222222-2222-4222-8222-222222222225')?.body;
        if (typeof storedBody !== 'string') throw new Error('Expected stored Board body');
        const envelope = ArtifactBodyEnvelopeV1Schema.parse(decodePlainArtifactStoredContent(storedBody));
        expect(typeof envelope.body).toBe('string');
        // The mounted UI queue is the trusted live-membership port, not a second writer.
        // Account capture, Action schema/policy and execution all stay real above the Artifact boundary.
        const uiBoard = { ...board, source: { picked: [{ kind: 'session' as const, qualifiedId: { serverId: target.id, id: 's1' } }] } };
        const uiPersistence = createWorkBoardArtifactBoundary({ v: 1, boards: [uiBoard] });
        const uiStore = createWorkBoardAccountStore(uiPersistence.transport, () => true);
        const uiPort = createWorkBoardUiActionPort(() => ({ scope: { serverId: target.id, accountId: 'board-owner' }, board: uiBoard,
            membership: projectBoardMembership(uiBoard, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true }), uiStore.queue, uiStore.readBoardAccess);
        const uiExecutor = createDefaultActionExecutor({ workBoardArtifacts: uiPort });
        expect(await uiExecutor.execute('boards.apply', { intent: { kind: 'set_positions', boardId: '22222222-2222-4222-8222-222222222225',
            positionsByItemRef: { [first]: { x: 72, y: 120 } } } }, { ...context, expectedAccountId: 'board-owner' }))
            .toMatchObject({ ok: true, result: { board: { positionsByItemRef: { [first]: { x: 72, y: 120 } } } } });
        expect(uiPersistence.acknowledged().boards[0]!.positionsByItemRef).toEqual({ [first]: { x: 72, y: 120 } });
        expect(board.positionsByItemRef[first]).toEqual({ x: 48, y: 96 });
        // Widget catalog admission requires this Home's genuine mounted Account;
        // the preceding Board writes still prove captured, non-focused Home routing.
        connection = await restoreServerAccountForTest({ serverUrl: target.serverUrl, accountId: 'board-owner', credentials: { token }, request });
        setRuntimeFetch(request);
        const surface = { serverId: target.id, accountId: 'board-owner', owner: { kind: 'workBoard', boardId: '22222222-2222-4222-8222-222222222225' } } as const;
        const instance = { v: 1, id: 'configured', definition: { kind: 'inline', definition: { v: 1, id: 'checks', name: 'Checks',
            sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' }, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } }, provenance: { source: { kind: 'authored' } } } }, bindings: {} } satisfies import('@happier-dev/protocol/widgets').WidgetInstanceV1;
        const widgetResult = await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: '22222222-2222-4222-8222-222222222225', ref: { surface, instanceId: instance.id }, instance } }, context);
        expect(widgetResult, JSON.stringify(widgetResult)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true, result: { instances: [{ instance, size: 'medium' }] } });
        expect(await executor.execute('widgets.item.size.set', { ref: { surface, instanceId: instance.id }, size: 'full' }, context)).toMatchObject({ ok: true });
        expect(currentBoard().widgets?.[0]?.size).toBe('full');
        expect(await executor.execute('widgets.item.remove', { ref: { surface, instanceId: instance.id } }, context)).toMatchObject({ ok: true });
        expect(currentBoard().widgets).toEqual([]);
        const listed = await executor.execute('boards.list', {}, context);
        expect(listed).toMatchObject({ ok: true, result: { boards: [{ id: '22222222-2222-4222-8222-222222222225' }] } });
        if (!listed.ok) throw new Error(listed.error);
        expect(WorkBoardActionOutputSchemasV1['boards.list'].parse(listed.result).boards).toEqual([currentBoard()]);
        const removed = await executor.execute('boards.apply', { intent: { kind: 'delete', boardId: '22222222-2222-4222-8222-222222222225' } }, context);
        expect(removed).toMatchObject({ ok: true });
        if (!removed.ok) throw new Error(removed.error);
        expect(WorkBoardActionOutputSchemasV1['boards.apply'].parse(removed.result)).toEqual({ boardId: '22222222-2222-4222-8222-222222222225', board: null });
        expect(persistence.read('22222222-2222-4222-8222-222222222225')).toBeNull();
        expect(requests).not.toContain('POST /v2/account/settings');
    });
});
