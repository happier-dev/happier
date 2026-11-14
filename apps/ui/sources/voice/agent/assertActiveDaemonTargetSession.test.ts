import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionFixture, createPlainMachineRowFixture, createMachineFixture } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';

vi.stubGlobal('__DEV__', true);
vi.stubGlobal('self', globalThis);

// Install the real Home/Account transport fixture before importing store/Sync consumers.
const network = await installSessionOpsNetworkBoundary();
let targetHome: Awaited<ReturnType<typeof network.addHome>>;
let focusedHome: Awaited<ReturnType<typeof network.addHome>>;
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
const { assertActiveDaemonTargetSession, resolveVoiceAgentSessionFromState } = await import('./voiceAgentRunState');
const { sessionRuntimeObservations } = await import('@/sync/domains/session/sessionRuntimeObservation');

function seedTargetSession(overrides: Parameters<typeof createSessionFixture>[0] = {}) {
    const session = createSessionFixture({
        id: 'target-1', serverId: targetHome.id, active: true,
        metadata: { flavor: 'claude', machineId: 'machine-1', path: '/tmp/target', host: 'voice.test' },
        ...overrides,
    });
    storage.setState({ sessions: { [session.id]: session }, sessionListIndexByServerId: {
        [targetHome.id]: [{ type: 'session', sessionId: session.id, serverId: targetHome.id, serverName: 'Target' }],
    } });
    return session;
}

describe('assertActiveDaemonTargetSession', () => {
    beforeEach(async () => {
        sessionRuntimeObservations.clear();
        network.resetRequests();
        targetHome = await network.addHome('https://voice-target.example.test', 'account-a');
        focusedHome = await network.addHome('https://voice-focused.example.test', 'account-a');
        network.setHttpResponder(async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/machines/machine-1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }) });
            return null;
        });
        await setActiveServer({ serverId: focusedHome.id });
        storage.setState({ sessions: {}, machines: {}, machineListByServerId: {}, sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
        seedTargetSession();
    });
    afterAll(() => network.dispose());

    it.each([true, false])('uses the bound Home Machine after navigation (target online: %s)', async (targetOnline) => {
        const targetMachine = createMachineFixture({ id: 'machine-1', active: targetOnline, activeAt: Date.now(), presenceProtocolVersion: 1 });
        const focusedMachine = createMachineFixture({ id: 'machine-1', active: !targetOnline, activeAt: Date.now(), presenceProtocolVersion: 1 });
        publishMachineActivityForTest([targetMachine]);
        publishMachineActivityForTest([focusedMachine]);
        storage.setState({
            machines: { 'machine-1': focusedMachine },
            machineListByServerId: { [targetHome.id]: [targetMachine], [focusedHome.id]: [focusedMachine] },
        });
        const admission = assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' });
        if (targetOnline) await expect(admission).resolves.toBeUndefined();
        else await expect(admission).rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
    });

    it('admits a live Codex context target with no terminal support or daemon declaration probe', async () => {
        seedTargetSession({ metadata: {
            flavor: 'codex', machineId: 'machine-1', path: '/tmp/target', host: 'voice.test',
            agentRuntimeCapabilitiesV1: { localControl: null },
        } });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' })).resolves.toBeUndefined();
        expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE))
            .toEqual([]);
    });

    it('leaves Agent selection admission to the initializer and Execution Run owner', async () => {
        seedTargetSession({ metadata: { machineId: 'machine-1', path: '/tmp/target', host: 'voice.test' } });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .resolves.toBeUndefined();
    });

    it('still reports inactive and offline targets', async () => {
        seedTargetSession({ active: false });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE' });
        seedTargetSession({ presence: 0 });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_OFFLINE' });
    });

    it('admits a running target before its live presence is observed (fresh client)', async () => {
        seedTargetSession({ presence: undefined });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: 'target-1' }))
            .resolves.toBeUndefined();
    });

    it('does not use a direct Session row from another Home for an explicit target', () => {
        seedTargetSession({ serverId: focusedHome.id });
        storage.setState({ sessionListIndexByServerId: {} });
        expect(resolveVoiceAgentSessionFromState({ serverId: targetHome.id, sessionId: 'target-1' })).toBeNull();
    });

    it('does not borrow online presence from another Home or admit a newer offline observation', async () => {
        const session = seedTargetSession({ active: false, presence: undefined, activeAt: 100 });
        sessionRuntimeObservations.observe({ serverId: focusedHome.id, sessionId: session.id },
            { active: true, activeAt: 200, presence: 'online' });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: session.id }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE' });
        sessionRuntimeObservations.observe({ serverId: targetHome.id, sessionId: session.id },
            { active: true, activeAt: 200, presence: 'online' });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: session.id }))
            .resolves.toBeUndefined();
        sessionRuntimeObservations.observe({ serverId: targetHome.id, sessionId: session.id },
            { active: false, activeAt: 201, presence: 201 });
        await expect(assertActiveDaemonTargetSession({ serverId: targetHome.id, sessionId: session.id }))
            .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE' });
    });

    it('fails closed when a bare Session ID is present on more than one Home', () => {
        storage.setState({ ordinarySessionListMembershipByServerId: {
            [targetHome.id]: ['target-1'], [focusedHome.id]: ['target-1'],
        } });
        expect(resolveVoiceAgentSessionFromState('target-1')).toBeNull();
    });
});
