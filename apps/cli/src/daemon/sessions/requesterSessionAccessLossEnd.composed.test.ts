import { afterEach, describe, expect, it } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';
import { registerMachineAccessLossReceiver } from '../externalActions/registerMachineAccessLossReceiver';
import { createSessionLiveWorkProducer } from '../lifecycle/sessionLiveWorkProducer';
import type { TrackedSession } from '../types';
import { createRequesterSessionAccessLossEnd } from './requesterSessionAccessLossEnd';
import {
  legacyPidSessionTrackingKey,
  type TrackedSessionMap,
} from './sessionTrackingKey';
import { createStopSession } from './stopSession';

const admission = (actorAccountId: string) => ({
  actorAccountId,
  custodianAccountId: 'owner',
  role: 'manage' as const,
  machineId: 'machine',
  installationId: 'installation',
  encryptionMode: 'plain' as const,
});
const idle: SessionInputLiveWork = {
  session: 'settled',
  input: 'settled',
  agents: 'settled',
  attention: 'settled',
  settledAt: 1,
};
const working: SessionInputLiveWork = {
  ...idle,
  session: 'active',
  input: 'active',
};

/**
 * Two people on the owner's Machine. The session host process and each runner's
 * live-work reply are the process boundaries; the Home's admission answers are
 * the network boundary. The receiver, the live-work producer, the boundary owner
 * and the ordinary Stop owner run as in the daemon.
 */
function fixture() {
  const lifetime = new AbortController();
  const tracked: TrackedSessionMap = new Map();
  const activity = new Map<string, SessionInputLiveWork>();
  const events: string[] = [];
  const accessRestored = new Set<string>();
  const producer = createSessionLiveWorkProducer({
    readSessions: () => [...tracked.values()],
    readActivity: async (session) =>
      activity.get(session.happySessionId!) ?? {
        session: 'unknown',
        input: 'unknown',
      },
  });
  let nextPid = 900;
  const host = (sessionId: string, accountId: string | null) => {
    const pid = nextPid++;
    let observe!: () => void;
    const session: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(pid),
      pid,
      startedBy: 'daemon',
      happySessionId: sessionId,
      ...(accountId
        ? {
            requesterWorkAttributionV1: {
              serverId: 'home',
              accountId,
              machineId: 'machine',
              installationId: 'installation',
            },
          }
        : {}),
      hostedSession: {
        // The session host process ends this Session and reports its exit.
        end: async () => {
          events.push(`end:${sessionId}`);
          tracked.delete(session.trackingKey);
          producer.notifyChanged();
          observe();
          return true;
        },
        observed: new Promise<void>((resolve) => {
          observe = resolve;
        }),
      },
    };
    tracked.set(session.trackingKey, session);
    activity.set(sessionId, idle);
    return session;
  };
  const stopSession = createStopSession({
    trackedSessionsByKey: tracked,
    readHostAttachmentState: async () => ({ status: 'absent' }),
    readTerminalAttachmentInfo: async () => null,
    waitForTrackedRunnersExit: async () => true,
  });
  const endSessions = createRequesterSessionAccessLossEnd({
    serverId: 'home',
    readSessions: () => tracked.values(),
    readLiveWork: async (session) =>
      activity.get(session.happySessionId!) ?? {
        session: 'unknown',
        input: 'unknown',
      },
    subscribeLiveWork: (sessionId, listener) =>
      producer.subscribe(listener, sessionId),
    isRequesterAccessCurrent: async (session) =>
      accessRestored.has(session.requesterWorkAttributionV1!.accountId),
    stopSession: (session) =>
      stopSession(session.happySessionId!, {
        expectedTrackedRunner: { tracked: session },
      }),
    lifetimeSignal: lifetime.signal,
  });
  const rpc = new RpcHandlerManager({
    scopePrefix: 'machine',
    encryptionMode: 'plain',
    logger: () => {},
    authorizeRequest: (request) =>
      authorizeMachineRpcRequest(request, {
        machineId: 'machine',
        resolveCustodianAccountId: async () => 'owner',
        resolveInstallationId: () => 'installation',
        verifyMachineAdmission: async () => true,
      }),
  });
  registerMachineAccessLossReceiver(rpc, {
    machineId: 'machine',
    serverId: 'home',
    resolveInstallationId: () => 'installation',
    readLiveWorkInventory: async () => producer.read(),
    cleanupRequesterMachineResources: async () => ({ kind: 'settled' }),
    endRequesterSessions: endSessions,
  });
  const call = (params: Record<string, unknown>) =>
    rpc.handleRequest({
      method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
      authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
      params: { v: 1, ...params },
      machineAdmission: admission('owner'),
    });
  const withdraw = (subjectAccountId: string, remainingRole?: 'use') =>
    call({ subjectAccountId, ...(remainingRole ? { remainingRole } : {}) });
  /** The runner finishes its turn, delivers the result, then pushes its settled live work. */
  const finishTurn = (sessionId: string) => {
    events.push(`result:${sessionId}`);
    activity.set(sessionId, idle);
    producer.notifySessionChanged(sessionId);
  };
  const startTurn = (sessionId: string) => {
    activity.set(sessionId, working);
  };
  const running = () =>
    [...tracked.values()].map((session) => session.happySessionId);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    host,
    withdraw,
    census: () => call({ kind: 'requesters' }),
    finishTurn,
    startTurn,
    running,
    events,
    accessRestored,
    flush,
    dispose: () => lifetime.abort(),
  };
}

let current: ReturnType<typeof fixture> | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

describe('withdrawn guest Sessions end at their natural boundary', () => {
  it('ends an idle guest Session at once and leaves the owner and other people running', async () => {
    const f = (current = fixture());
    f.host('owner-session', 'owner');
    f.host('owner-plain-session', null);
    f.host('guest-session', 'guest');
    f.host('other-session', 'other');
    expect(await f.withdraw('guest')).toEqual({ kind: 'settled' });
    expect(f.running()).toEqual([
      'owner-session',
      'owner-plain-session',
      'other-session',
    ]);
    expect(f.events).toEqual(['end:guest-session']);
  });

  it('lets a running turn finish and deliver its result before the Session ends', async () => {
    const f = (current = fixture());
    f.host('guest-session', 'guest');
    f.startTurn('guest-session');
    const outcome = f.withdraw('guest');
    await f.flush();
    expect(f.running()).toEqual(['guest-session']);
    f.finishTurn('guest-session');
    expect(await outcome).toEqual({ kind: 'settled' });
    expect(f.events).toEqual(['result:guest-session', 'end:guest-session']);
    expect(f.running()).toEqual([]);
  });

  it('keeps the Session when Manage narrows to Use', async () => {
    const f = (current = fixture());
    f.host('guest-session', 'guest');
    expect(await f.withdraw('guest', 'use')).toEqual({ kind: 'settled' });
    expect(f.running()).toEqual(['guest-session']);
  });

  it('keeps the Session when access is restored before the running turn finishes', async () => {
    const f = (current = fixture());
    f.host('guest-session', 'guest');
    f.startTurn('guest-session');
    const outcome = f.withdraw('guest');
    await f.flush();
    f.accessRestored.add('guest');
    f.finishTurn('guest-session');
    expect(await outcome).toEqual({ kind: 'settled' });
    expect(f.running()).toEqual(['guest-session']);
    expect(f.events).toEqual(['result:guest-session']);
  });

  it('reaches a withdrawal missed while the daemon was offline through the reconnect census', async () => {
    const f = (current = fixture());
    f.host('owner-session', 'owner');
    f.host('guest-session', 'guest');
    const census = await f.census();
    expect(census).toMatchObject({ kind: 'requesters', coverage: 'complete' });
    expect((census as { accountIds: string[] }).accountIds).toContain('guest');
    // The Home re-decides each census subject from its current role; the guest has none.
    expect(await f.withdraw('guest')).toEqual({ kind: 'settled' });
    expect(f.running()).toEqual(['owner-session']);
  });

  it('reuses the pending end when the same loss is dispatched again mid-turn', async () => {
    const f = (current = fixture());
    f.host('guest-session', 'guest');
    f.startTurn('guest-session');
    const first = f.withdraw('guest');
    const second = f.withdraw('guest');
    await f.flush();
    f.finishTurn('guest-session');
    expect(await Promise.all([first, second])).toEqual([
      { kind: 'settled' },
      { kind: 'settled' },
    ]);
    expect(f.events).toEqual(['result:guest-session', 'end:guest-session']);
  });
});
