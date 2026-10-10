import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createActionExecutorBoundaryFixture, createDeferred } from '@/dev/testkit';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import type { StorageState } from '@/sync/store/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const boundary = vi.hoisted(() => ({ ensure: vi.fn(), alert: vi.fn() }));
const runtime = vi.hoisted(() => ({ serverId: '' }));
// Applied connection identity is a process/network boundary; Account fencing stays real.
vi.mock('@/sync/runtime/orchestration/appliedActiveServerRuntime', () => ({
    getAppliedActiveServerSnapshot: () => runtime,
    isAppliedActiveServerRuntimeAvailable: () => true,
}));
vi.mock('@/sync/ops/machineExternalSessions', () => ({ machineExternalSessionLinkEnsure: boundary.ensure }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: boundary.alert } }).module;
});

import { openExternalSessionCandidate, type ExternalSessionCandidateOpenState } from './openExternalSessionCandidate';

let profileScope: ServerAccountScope | null = null;
function input() {
    const state: ExternalSessionCandidateOpenState = { requestToken: 0, linkingCandidateKey: null };
    return {
        candidate: { remoteSessionId: 'native-session', title: 'A title', updatedAtMs: 1 },
        agentId: 'fixture-agent', source: { kind: 'fixture-source' },
        actionsAllowed: true, offline: false, isSelectionCurrent: () => true,
        resolveCurrentTarget: () => ({ machineId: 'machine-a', serverId: profileScope!.serverId }),
        state, onLinkingChange: vi.fn(), openSession: vi.fn(),
    };
}

describe('openExternalSessionCandidate', () => {
    it('uses the admitted existing link Action and never grants capture consent', async () => {
        const actions: string[] = [];
        // The protocol executor transport port is outside this process-owned UI adapter.
        const deps = createActionExecutorBoundaryFixture({ isActionApprovalRequired: () => false, hostExternalSessionAction: async ({ actionId }) => {
            actions.push(actionId);
            return { ok: true as const, result: { ok: true, sessionId: 'continued', created: true } };
        } });
        const executor = createActionExecutor(deps);
        const params = input();
        expect(await openExternalSessionCandidate({ ...params, linkActionExecute: createFrontDoorActionExecute(executor) })).toBe('opened');
        expect(actions).toEqual(['sessions.external.link.ensure']);
        expect(params.openSession).toHaveBeenCalledWith('continued', params.resolveCurrentTarget(), undefined);
        expect(boundary.ensure).not.toHaveBeenCalled();
    });
    it('does not navigate or grant capture when the admitted link Account retires', async () => {
        const pending = createDeferred<{ ok: true; result: { ok: true; sessionId: string; created: boolean } }>();
        let current = true;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ isActionApprovalRequired: () => false,
            hostExternalSessionAction: () => pending.promise,
        }));
        const params = input();
        const opening = openExternalSessionCandidate({ ...params, accountCurrentness: { isCurrent: () => current },
            linkActionExecute: createFrontDoorActionExecute(executor) });
        current = false;
        pending.resolve({ ok: true, result: { ok: true, sessionId: 'retired-account-session', created: true } });
        expect(await opening).toBe('ignored');
        expect(params.openSession).not.toHaveBeenCalled();
        expect(boundary.ensure).not.toHaveBeenCalled();
    });
    beforeEach(async () => {
        boundary.ensure.mockReset().mockResolvedValue({ ok: true, sessionId: 'happier-session', created: true });
        boundary.alert.mockReset();
        const server = await upsertAndActivateServer({ serverUrl: 'https://candidate-open.test' });
        runtime.serverId = server.id;
        profileScope = { serverId: server.id, accountId: 'account-a' };
        registerStorageStateReader(() => ({ profileScope } as unknown as StorageState));
    });
    afterEach(() => {
        profileScope = null;
        registerStorageStateReader(() => null as unknown as StorageState);
    });

    it('links once and hands off a message identity seed, never a transcript ordinal', async () => {
        const params = input();
        expect(await openExternalSessionCandidate({
            ...params, find: { query: 'body-only phrase', sourceItemId: 'record-uuid' },
        })).toBe('opened');
        expect(params.openSession).toHaveBeenCalledWith('happier-session', params.resolveCurrentTarget(), {
            query: 'body-only phrase', options: { matchCase: false, regex: false },
            target: {
                kind: 'route-message-id',
                routeMessageId: makeExternalSessionHistoricalImportLocalId({
                    agentId: 'fixture-agent', remoteSessionId: 'native-session', directItemId: 'record-uuid',
                }),
            },
        });
    });

    it('suppresses stale selections and offline unlinked rows but permits local linked opening', async () => {
        const params = input();
        expect(await openExternalSessionCandidate({ ...params, isSelectionCurrent: () => false })).toBe('ignored');
        expect(await openExternalSessionCandidate({ ...params, accountCurrentness: { isCurrent: () => false },
            candidate: { ...params.candidate, linkedSessionId: 'retired-account-session' },
        })).toBe('ignored');
        expect(await openExternalSessionCandidate({ ...params, offline: true })).toBe('ignored');
        expect(boundary.ensure).not.toHaveBeenCalled();
        expect(await openExternalSessionCandidate({ ...params, offline: true, candidate: { ...params.candidate, linkedSessionId: 'already-linked' } })).toBe('opened');
        expect(params.openSession).toHaveBeenCalledWith('already-linked', params.resolveCurrentTarget(), undefined);
    });

    it('retires navigation and alerts on an Account switch and rejects overlapping link requests', async () => {
        const pending = createDeferred<{ ok: true; sessionId: string; created: boolean }>();
        boundary.ensure.mockImplementation(() => pending.promise);
        const params = input();
        const opening = openExternalSessionCandidate(params);
        expect(await openExternalSessionCandidate(params)).toBe('ignored');
        profileScope = { serverId: profileScope!.serverId, accountId: 'account-b' };
        pending.resolve({ ok: true, sessionId: 'account-a-session', created: true });
        expect(await opening).toBe('ignored');
        expect(params.openSession).not.toHaveBeenCalled();
        expect(boundary.alert).not.toHaveBeenCalled();
        expect(params.state.linkingCandidateKey).toBeNull();
    });

    it('uses the exact selected Home lifetime rather than ambient Account custody', async () => {
        const pending = createDeferred<{ ok: true; sessionId: string; created: boolean }>();
        boundary.ensure.mockImplementation(() => pending.promise);
        const original = input();
        const target = { ...original.resolveCurrentTarget(), accountId: 'selected-account' };
        const params = { ...original, resolveCurrentTarget: () => target, accountCurrentness: { isCurrent: () => true } };
        const opening = openExternalSessionCandidate(params);
        profileScope = { serverId: profileScope!.serverId, accountId: 'another-active-account' };
        pending.resolve({ ok: true, sessionId: 'selected-home-session', created: true });
        expect(await opening).toBe('opened');
        expect(params.openSession).toHaveBeenCalledWith('selected-home-session', { machineId: target.machineId, serverId: target.serverId }, undefined);
        expect(boundary.ensure).toHaveBeenCalledWith(expect.anything(), { serverId: target.serverId, accountId: 'selected-account' });
    });
});
