import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createSessionFixture } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';

const transport = vi.hoisted(() => vi.fn());
// Only the remote Session RPC hop is replaced; the UI Action front door stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async importOriginal => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: { sessionRpcWithServerScope: transport } });
});

const { storage } = await import('@/sync/domains/state/storageStore');
const { roleActions } = await import('./roleActions');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');

const previous = storage.getState();
let home: Awaited<ReturnType<typeof serveSessionActionHome>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; storage.setState(previous); transport.mockReset(); });

describe('session role Action Home routing', () => {
    it('refuses the stopped coordinator Role on both attempts and admits it only once its runtime is serving again', async () => {
        home = await serveSessionActionHome();
        storage.setState({ sessions: { worker: createSessionFixture({ id: 'worker', serverId: home.serverId, active: false }) } });
        // Only Session RPC is substituted: the public composite, target admission,
        // role dispatch and partial-result projection all execute normally.
        transport.mockRejectedValue(createRpcCallError({ error: 'RPC target unavailable', errorCode: 'target_unavailable' }));
        const execute = createFrontDoorActionExecute(undefined, { presentUserActionConfirmation: async () => true });
        const input = { sessionId: 'worker', roleId: 'orchestrator', keep: 'none', ruleSuggestions: [] };
        const context = { surface: 'ui' as const, serverId: home.serverId };
        for (let attempt = 0; attempt < 2; attempt++) {
            expect(await execute('session.coordinator.enable', input, context)).toMatchObject({ ok: true, result: {
                status: 'partial', effects: [{ operation: 'role', status: 'failed', errorCode: 'target_unavailable' }],
            } });
        }
        transport.mockResolvedValue(RoleActionOutputSchemasV1['session.role.set'].parse({ updated: true }));
        expect(await execute('session.coordinator.enable', input, context)).toMatchObject({ ok: true, result: {
            status: 'configured', effects: [{ operation: 'role', status: 'accepted' }],
        } });
    });

    it('keeps notes and role writes at the explicitly selected Home despite a colliding live Session', async () => {
        home = await serveSessionActionHome({ homes: [
            { key: 'b', serverUrl: 'https://roles-b.test', accountId: 'account-b', currentAccount: true },
            { key: 'a', serverUrl: 'https://roles-a.test', accountId: 'account-a', currentAccount: true },
        ], route: () => undefined });
        const selectedHome = home.homes.b.id;
        storage.setState({ sessions: { worker: createSessionFixture({ id: 'worker', serverId: home.homes.a.id }) } });
        transport.mockImplementation(async ({ serverId, sessionId, method, payload }) => {
            expect(serverId).toBe(selectedHome);
            expect(sessionId).toBe('worker');
            if (method === 'session.notes.set') {
                expect(RoleActionInputSchemasV1['session.notes.set'].parse(payload)).toEqual({ sessionId: 'worker', notes: 'Notes for B' });
                return RoleActionOutputSchemasV1['session.notes.set'].parse({ updated: true });
            }
            if (method === 'session.role.set') {
                const parsed = RoleActionInputSchemasV1['session.role.set'].parse(payload);
                expect(parsed).toEqual('answersWorkerQuestions' in parsed
                    ? { sessionId: 'worker', answersWorkerQuestions: false }
                    : { sessionId: 'worker', roleId: 'builder' });
                return RoleActionOutputSchemasV1['session.role.set'].parse({ updated: true });
            }
            throw new Error('Unexpected Session RPC');
        });
        expect(await roleActions.setSessionNotes('worker', 'Notes for B', { serverId: selectedHome }))
            .toEqual({ ok: true, result: { updated: true } });
        expect(await roleActions.setSessionRole('worker', 'builder', { serverId: selectedHome }))
            .toEqual({ ok: true, result: { updated: true } });
        expect(await roleActions.setSessionAnswersWorkerQuestions('worker', false, { serverId: selectedHome }))
            .toEqual({ ok: true, result: { updated: true } });
    });

    it('preserves the typed idle-runtime refusal through the real UI Action executor', async () => {
        home = await serveSessionActionHome();
        storage.setState({ sessions: { worker: createSessionFixture({ id: 'worker', serverId: home.serverId, active: false }) } });
        transport.mockRejectedValue(createRpcCallError({ error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
        expect(await roleActions.setSessionRole('worker', 'orchestrator', { serverId: home.serverId }))
            .toMatchObject({ ok: false, errorCode: 'session_role_runtime_unavailable' });
    });

    it('refuses an ambiguous bare Session instead of choosing the focused Home', async () => {
        storage.setState({ sessions: { worker: createSessionFixture({ id: 'worker', serverId: 'home-a' }) },
            ordinarySessionListMembershipByServerId: { 'home-a': ['worker'], 'home-b': ['worker'] } });
        const result = await roleActions.setSessionNotes('worker', 'Ambiguous');
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(transport).not.toHaveBeenCalled();
    });
});
