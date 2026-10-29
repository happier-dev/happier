import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, createMachineFixture } from '@/dev/testkit';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const boundary = vi.hoisted(() => ({ ensure: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => true) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: boundary.alert, confirm: boundary.confirm } }).module;
});

import type { ExternalSessionCandidateOpenState } from './openExternalSessionCandidate';

const homes = createHomeGovernanceHarness();
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(homes);
const requests: SocketRpcRequestPayload[] = [];
await loadSyncSingletonForTests();
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { openExternalSessionCandidate } = await import('./openExternalSessionCandidate');
const { readExternalSessionBrowseCandidatePath } = await import('./useExternalSessionBrowseCandidates');
const { storage } = await import('@/sync/domains/state/storage');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

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
    it('keeps legacy directory hints and unknown paths', () => {
        expect(readExternalSessionBrowseCandidatePath({ cwd: '  ', details: { cwd: ' /repo/legacy cwd ' } })).toBe('/repo/legacy cwd');
        expect(readExternalSessionBrowseCandidatePath({ details: { path: ' /repo/legacy path ' } })).toBe('/repo/legacy path');
        expect(readExternalSessionBrowseCandidatePath({})).toBeNull();
    });
    it('uses the admitted existing link Action and never grants capture consent', async () => {
        boundary.ensure.mockResolvedValueOnce({ ok: true, sessionId: 'continued', created: true });
        const frontDoor = createFrontDoorActionExecute();
        // Observe invocation without substituting policy, admission or dispatch.
        const execute = Object.assign(vi.fn(frontDoor), { prepare: frontDoor.prepare });
        const params = input();
        expect(await openExternalSessionCandidate({ ...params,
            candidate: { ...params.candidate, cwd: ' /repo/native cwd ', details: { cwd: '/legacy/should-not-win' } },
            linkActionExecute: execute })).toBe('opened');
        expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual(['sessions.external.link.ensure']);
        expect(params.openSession).toHaveBeenCalledWith('continued', params.resolveCurrentTarget(), undefined);
        expect(requests).toMatchObject([{ method: `machine-a:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE}`,
            params: { directoryHint: '/repo/native cwd' } }]);
        expect(boundary.ensure).toHaveBeenCalledOnce();
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });
    it('does not navigate or grant capture when the admitted link Account retires', async () => {
        const pending = createDeferred<{ ok: true; sessionId: string; created: boolean }>();
        let current = true;
        boundary.ensure.mockImplementationOnce(() => pending.promise);
        const params = input();
        const opening = openExternalSessionCandidate({ ...params, accountCurrentness: { isCurrent: () => current },
            linkActionExecute: createFrontDoorActionExecute() });
        await vi.waitFor(() => expect(boundary.ensure).toHaveBeenCalledOnce());
        current = false;
        pending.resolve({ ok: true, sessionId: 'retired-account-session', created: true });
        expect(await opening).toBe('ignored');
        expect(params.openSession).not.toHaveBeenCalled();
        expect(boundary.ensure).toHaveBeenCalledOnce();
        expect(homes.requestsFor('/v2/account/settings').filter(request => request.input !== null)).toEqual([]);
    });
    beforeEach(async () => {
        await homes.reset();
        network.resetRequests();
        await network.addHome('https://candidate-open.test', 'account-a');
        network.setRpcResponder(call => {
            const request = { method: `${call.targetId}:${call.method}`, params: call.payload };
            requests.push(request);
            return boundary.ensure(request);
        });
        installHomeGovernanceBoundaries(homes);
        requests.length = 0;
        boundary.ensure.mockReset().mockResolvedValue({ ok: true, sessionId: 'happier-session', created: true });
        boundary.alert.mockReset();
        // Real Action admission still asks for confirmation; this network/native-boundary
        // fixture models the person accepting it, independently of source capture consent.
        boundary.confirm.mockReset().mockResolvedValue(true);
        const serverId = await homes.addHome({ name: 'Candidate Home', serverUrl: 'https://candidate-open.test', accountId: 'account-a' });
        const machine = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-a' });
        homes.answer(serverId, '/v1/machines/machine-a', { body: { machine } });
        homes.answer(serverId, '/v1/machines', { body: [machine] });
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {},
                approvalWaivedSurfaces: { 'sessions.external.link.ensure': ['ui'] } }),
        } }, version: 1 } });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://candidate-open.test', accountId: 'account-a',
            additionalRequestOrigins: ['https://selected-candidate.test'], request: homes.request });
        installHomeGovernanceBoundaries(homes);
        profileScope = { serverId: connection.home.id, accountId: 'account-a' };
    });
    afterEach(async () => {
        await connection?.dispose();
        connection = undefined;
        profileScope = null;
    });
    afterAll(() => network.dispose());

    it('links once and hands off a message identity seed, never a transcript ordinal', async () => {
        const params = input();
        expect(await openExternalSessionCandidate({
            ...params, find: { query: 'body-only phrase', sourceItemId: 'record-uuid' },
        })).toBe('opened');
        expect(params.openSession).toHaveBeenCalledWith('happier-session', params.resolveCurrentTarget(), {
            query: 'body-only phrase', options: { matchCase: false, regex: false },
            target: {
                kind: 'route-message-id',
                routeMessageId: `server:${makeExternalSessionHistoricalImportLocalId({
                    agentId: 'fixture-agent', remoteSessionId: 'native-session', directItemId: 'record-uuid',
                })}`,
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
        expect(await openExternalSessionCandidate({ ...params, offline: true, candidate: { ...params.candidate, linkedSessionId: 'already-linked' },
            find: { query: 'body-only phrase', sourceItemId: 'record-uuid' },
        })).toBe('opened');
        expect(params.openSession).toHaveBeenCalledWith('already-linked', params.resolveCurrentTarget(), {
            query: 'body-only phrase', options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: `server:${makeExternalSessionHistoricalImportLocalId({
                agentId: 'fixture-agent', remoteSessionId: 'native-session', directItemId: 'record-uuid',
            })}` },
        });
    });

    it('retires navigation and alerts on an Account switch and rejects overlapping link requests', async () => {
        const pending = createDeferred<{ ok: true; sessionId: string; created: boolean }>();
        boundary.ensure.mockImplementation(() => pending.promise);
        const params = input();
        const opening = openExternalSessionCandidate(params);
        expect(await openExternalSessionCandidate(params)).toBe('ignored');
        profileScope = { serverId: profileScope!.serverId, accountId: 'account-b' };
        storage.setState({ profileScope });
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
        const selectedHomeId = await homes.addHome({ name: 'Selected candidate Home', serverUrl: 'https://selected-candidate.test',
            accountId: 'selected-account', active: false });
        await network.addHome('https://selected-candidate.test', 'selected-account');
        const machine = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'selected-account' });
        homes.answer(selectedHomeId, '/v1/machines/machine-a', { body: { machine } });
        homes.answer(selectedHomeId, '/v1/machines', { body: [machine] });
        storage.setState(state => ({ machineListByServerId: { ...state.machineListByServerId,
            [selectedHomeId]: [createMachineFixture({ id: 'machine-a', activeAt: Date.now() })],
        }, machineListStatusByServerId: { ...state.machineListStatusByServerId, [selectedHomeId]: 'idle' } }));
        homes.answer(selectedHomeId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {},
                approvalWaivedSurfaces: { 'sessions.external.link.ensure': ['ui'] } }),
        } }, version: 1 } });
        const target = { machineId: 'machine-a', serverId: selectedHomeId, accountId: 'selected-account' };
        const params = { ...original, resolveCurrentTarget: () => target, accountCurrentness: { isCurrent: () => true } };
        const opening = openExternalSessionCandidate(params);
        await vi.waitFor(() => expect(boundary.ensure).toHaveBeenCalledOnce());
        profileScope = { serverId: profileScope!.serverId, accountId: 'another-active-account' };
        storage.setState({ profileScope });
        pending.resolve({ ok: true, sessionId: 'selected-home-session', created: true });
        expect(await opening).toBe('opened');
        expect(params.openSession).toHaveBeenCalledWith('selected-home-session', { machineId: target.machineId, serverId: target.serverId }, undefined);
        expect(requests).toMatchObject([{ method: expect.stringMatching(/^machine-a:/), params: { remoteSessionId: 'native-session' } }]);
        expect(homes.requests.find(request => request.serverId === selectedHomeId && request.path === '/v1/machines/read-batch'))
            .toMatchObject({ token: expect.any(String), input: { machineIds: ['machine-a'] } });
    });
});
