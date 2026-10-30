import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const directBackends = { claude: { available: true, intents: ['review'] } };
const staleBackends = { codex: { available: true, intents: ['plan'] } };
const peerBackends = { gemini: { available: true, intents: ['review'] } };
let account: ReturnType<typeof import('@/dev/testkit/harness/providerSettingsHarness').createProviderSettingsAccountHarness>;
let transport: ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').installDisconnectedServerSocketBoundary>;
const requests: { method: string; machineId: string; serverId: string | null }[] = [];
let activeServerId: string;
let peerServerId: string;
let directMachineId: string;
let staleMachineId: string;
let caseNumber = 0;
let restoreStorage = () => {};

async function seedSession(metadata: Partial<NonNullable<Session['metadata']>>, serverId?: string,
  resolvedMachineId?: string) {
  const { storage } = await import('@/sync/domains/state/storage');
  const session = createSessionFixture({ id: 'session-1', serverId,
    metadata: { path: '/tmp/linked', host: 'tester.local', ...metadata } });
  const resolved = resolvedMachineId ? createSessionFixture({ ...session,
    metadata: { ...session.metadata, host: 'tester.local', machineId: resolvedMachineId, path: '/tmp/reachable' } }) : session;
  storage.setState(state => ({ sessions: { [session.id]: session },
    sessionListRowsByServerId: serverId ? { ...state.sessionListRowsByServerId,
      [serverId]: { [session.id]: buildSessionListRenderableFromSession(resolved) } } : state.sessionListRowsByServerId,
  }));
}

const linkedMetadata = () => ({ externalSessionV1: { v: 1 as const, agentId: 'claude',
  machineId: directMachineId, remoteSessionId: 'remote-session-1',
  source: { kind: 'claudeConfig' as const, configDir: '/tmp/claude-config' } } });

async function mount(sessionId = 'session-1', serverId?: string) {
  const { useExecutionRunsBackendsForSession } = await import('./useExecutionRunsBackendsForSession');
  return renderHook((props: { sessionId: string; serverId?: string }) =>
    useExecutionRunsBackendsForSession(props.sessionId, props.serverId), { initialProps: { sessionId, serverId } });
}

describe('useExecutionRunsBackendsForSession', () => {
  beforeEach(async () => {
    directMachineId = `machine-direct-${++caseNumber}`;
    staleMachineId = `machine-stale-${caseNumber}`;
    const { storage } = await import('@/sync/domains/state/storage');
    const { sessions, machines: savedMachines, machineListByServerId, sessionListRowsByServerId } = storage.getState();
    restoreStorage = () => storage.setState({ sessions, machines: savedMachines, machineListByServerId, sessionListRowsByServerId });
    const { createProviderSettingsAccountHarness } =
      await import('@/dev/testkit/harness/providerSettingsHarness');
    const { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } =
      await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    const machines = [directMachineId, staleMachineId].map(id => createMachineFixture({ id, active: true, activeAt: Date.now() }));
    requests.length = 0;
    account = createProviderSettingsAccountHarness();
    // Only Socket SDK acknowledgements are replaced; cache, scoped routing and parsing remain real.
    transport = installDisconnectedServerSocketBoundary((socket, serverUrl) => {
      configureConnectedServerSocketBoundary(socket);
      socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
          || typeof payload.method !== 'string') throw new Error('Malformed execution capability RPC');
        const separator = payload.method.indexOf(':');
        const machineId = payload.method.slice(0, separator);
        const method = payload.method.slice(separator + 1);
        if (separator < 1 || method !== 'capabilities.detect') throw new Error('Unexpected execution capability RPC');
        const isPeer = serverUrl === 'https://execution-peer.example.test';
        requests.push({ machineId, method, serverId: isPeer ? peerServerId : activeServerId });
        return { ok: true, result: { protocolVersion: 1,
          results: { 'tool.executionRuns': { ok: true, checkedAt: 1, data: { backends:
            isPeer ? peerBackends : machineId === directMachineId ? directBackends : staleBackends,
          } } } } };
      });
    });
    activeServerId = (await account.restore({ machines })).serverId;
    peerServerId = await account.addHome({ name: 'Other Home', serverUrl: 'https://execution-peer.example.test',
      accountId: 'peer-account', active: false });
    await account.publishMachines(peerServerId, machines);
  });

  afterEach(async () => {
    standardCleanup();
    await account?.reset();
    transport?.dispose();
    restoreStorage();
  });

  it('uses the linked direct-session machine id when top-level session metadata has no machine id', async () => {
    await seedSession(linkedMetadata());
    const hook = await mount();
    await vi.waitFor(() => expect(hook.getCurrent()).toEqual(directBackends));
    expect(requests).toContainEqual(expect.objectContaining({ method: 'capabilities.detect',
      machineId: directMachineId, serverId: activeServerId }));
  });

  it('prefers the resolved session machine target over stale session metadata', async () => {
    await seedSession({ machineId: staleMachineId, path: '/tmp/stale' }, activeServerId, directMachineId);
    const hook = await mount('session-1', activeServerId);
    await vi.waitFor(() => expect(hook.getCurrent()).toEqual(directBackends));
    expect(requests.filter(request => request.method === 'capabilities.detect').map(request => request.machineId))
      .toEqual([directMachineId]);
  });

  it('scopes the execution-run capability lookup to the canonical session server', async () => {
    await seedSession(linkedMetadata(), peerServerId);
    const hook = await mount('session-1', peerServerId);
    await vi.waitFor(() => expect(hook.getCurrent()).toEqual(peerBackends));
    expect(requests).toContainEqual(expect.objectContaining({ method: 'capabilities.detect',
      machineId: directMachineId, serverId: peerServerId }));
  });

  it('updates when the caller changes the canonical server id', async () => {
    await seedSession(linkedMetadata());
    const hook = await mount();
    await vi.waitFor(() => expect(hook.getCurrent()).toEqual(directBackends));
    await seedSession(linkedMetadata(), peerServerId);
    await hook.rerender({ sessionId: 'session-1', serverId: peerServerId });
    await vi.waitFor(() => expect(hook.getCurrent()).toEqual(peerBackends));
    expect(requests.filter(request => request.method === 'capabilities.detect').map(request => request.serverId))
      .toEqual([activeServerId, peerServerId]);
  });

  it('normalizes session ids before resolving execution-run backends', async () => {
    await seedSession(linkedMetadata());
    const hook = await mount('  session-1  ');
    await vi.waitFor(() => expect(hook.getCurrent()).toEqual(directBackends));
    expect(requests).toContainEqual(expect.objectContaining({ method: 'capabilities.detect', machineId: directMachineId }));
  });
});
