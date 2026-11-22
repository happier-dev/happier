import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import {
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  parseAccountStoredContentCompatibilitySocketAuthV1,
} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { createSocketRoomDiscoveryHarness } from '@/app/api/testkit/socketHarness';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { removeMachineAccessGrantInTx } from './machineAccess';
import {
  dispatchMachineAccessLossCustody,
  recoverMachineAccessLossCustody,
} from './machineAccessCustody';
import { RpcHandlerManager } from '../../../../cli/src/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '../../../../cli/src/api/machine/machineRpcAuthorization';
import { registerMachineAccessLossReceiver } from '../../../../cli/src/daemon/externalActions/registerMachineAccessLossReceiver';
import { createSessionLiveWorkProducer } from '../../../../cli/src/daemon/lifecycle/sessionLiveWorkProducer';
import { createRequesterSessionAccessLossEnd } from '../../../../cli/src/daemon/sessions/requesterSessionAccessLossEnd';
import { createStopSession } from '../../../../cli/src/daemon/sessions/stopSession';
import {
  legacyPidSessionTrackingKey,
  type TrackedSessionMap,
} from '../../../../cli/src/daemon/sessions/sessionTrackingKey';
import type { TrackedSession } from '../../../../cli/src/daemon/types';
import type { SessionInputLiveWork } from '../../../../cli/src/agent/runtime/session/input/_types';

// The Home's ordinary request deadline is short here so a turn can outlive it without a real 30 s wait.
const HOME_DEFAULT_DEADLINE_MS = 200;
const outlivesHomeDeadline = () =>
  new Promise((resolve) => setTimeout(resolve, HOME_DEFAULT_DEADLINE_MS * 3));
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
 * The real Home custody owner forwards through the real RPC forwarder to the real
 * daemon receiver, Session end owner, live-work producer and Stop owner. The
 * socket ACK (Socket.IO's timeout semantics) and the session host process are the
 * boundaries; each runner's live work is its own report.
 */
async function fixture() {
  const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
  const guests = await Promise.all(
    [0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain' } })),
  );
  const machine = await db.machine.create({
    data: {
      id: randomUUID(),
      accountId: owner.id,
      active: true,
      metadata: encodePlainMachineStoredContent({
        host: 'turn-boundary',
        platform: process.platform,
        happyCliVersion: 'test',
        homeDir: '/fixture',
        happyHomeDir: '/fixture/.happier',
      }),
      installationId: randomUUID(),
      dataEncryptionKey: new Uint8Array(
        Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
      ),
    },
  });
  const installationId = machine.installationId!;
  const lifetime = new AbortController();
  const tracked: TrackedSessionMap = new Map();
  const activity = new Map<string, SessionInputLiveWork>();
  const producer = createSessionLiveWorkProducer({
    readSessions: () => [...tracked.values()],
    readActivity: async (session) =>
      activity.get(session.happySessionId!) ?? {
        session: 'unknown',
        input: 'unknown',
      },
  });
  let nextPid = 7100;
  let pushRevision = 0;
  const host = (accountId: string) => {
    const pid = nextPid++;
    const sessionId = randomUUID();
    let observe!: () => void;
    const session: TrackedSession = {
      trackingKey: legacyPidSessionTrackingKey(pid),
      pid,
      startedBy: 'daemon',
      happySessionId: sessionId,
      requesterWorkAttributionV1: {
        serverId: 'home',
        accountId,
        machineId: machine.id,
        installationId,
      },
      hostedSession: {
        end: async () => {
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
  const push = (session: TrackedSession, work: SessionInputLiveWork) => {
    activity.set(session.happySessionId!, work);
    producer.notifySessionChanged(session.happySessionId!, {
      runnerPid: session.pid,
      revision: ++pushRevision,
      activity: work,
    });
  };
  const stopSession = createStopSession({
    trackedSessionsByKey: tracked,
    readHostAttachmentState: async () => ({ status: 'absent' }),
    readTerminalAttachmentInfo: async () => null,
    waitForTrackedRunnersExit: async () => true,
  });
  const failure = { resources: false };
  const rpc = new RpcHandlerManager({
    scopePrefix: machine.id,
    encryptionMode: 'plain',
    logger: () => {},
    authorizeRequest: (request, source) =>
      authorizeMachineRpcRequest(
        request,
        {
          machineId: machine.id,
          resolveCustodianAccountId: async () => owner.id,
          resolveInstallationId: () => installationId,
          verifyMachineAdmission: async () => true,
        },
        source,
      ),
  });
  registerMachineAccessLossReceiver(rpc, {
    machineId: machine.id,
    serverId: 'home',
    resolveInstallationId: () => installationId,
    readLiveWorkInventory: async () => producer.read(),
    cleanupRequesterMachineResources: async () => ({
      kind: failure.resources ? 'incomplete' : 'settled',
    }),
    endRequesterSessions: createRequesterSessionAccessLossEnd({
      serverId: 'home',
      readSessions: () => tracked.values(),
      readLiveWorkItems: async () => (await producer.read('changed')).items,
      subscribeLiveWork: (sessionId, listener) =>
        producer.subscribe(listener, sessionId),
      isRequesterAccessCurrent: async () => false,
      stopSession: (session, lifecycleStateReason) =>
        stopSession(session.happySessionId!, {
          lifecycleStateReason,
          expectedTrackedRunner: { tracked: session },
        }),
      lifetimeSignal: lifetime.signal,
    }),
  });
  // What each forward asked of the transport, and each daemon answer, in order.
  const forwards: {
    ackDeadlineMs: number;
    daemonDeadlineMs: unknown;
    params: unknown;
  }[] = [];
  const answers: { params: unknown; result: unknown }[] = [];
  const openAcks = new Set<(error: Error) => void>();
  const method = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
  const target = {
    id: 'turn-boundary-daemon',
    data: {
      clientType: 'machine-scoped',
      userId: owner.id,
      machineId: machine.id,
      verifiedMachineInstallationId: installationId,
      accountStoredContentCompatibility: evaluateAccountStoredContentCompatibility(
        parseAccountStoredContentCompatibilitySocketAuthV1({
          accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        }),
      ),
    },
    timeout: (ackDeadlineMs: number) => ({
      emitWithAck: (_event: string, request: SocketRpcRequestPayload) =>
        new Promise<unknown>((resolve, reject) => {
          forwards.push({
            ackDeadlineMs,
            daemonDeadlineMs: request.timeoutMs,
            params: request.params,
          });
          // Socket.IO rejects an ACK that outlives its deadline, or whose socket disconnects.
          const timer =
            ackDeadlineMs < 2_147_483_647
              ? setTimeout(
                  () => reject(new Error('operation has timed out')),
                  ackDeadlineMs,
                )
              : undefined;
          const disconnect = (error: Error) => {
            clearTimeout(timer);
            reject(error);
          };
          openAcks.add(disconnect);
          void rpc
            .handleRequest(
              request as never,
              undefined,
              'authenticated_home_socket',
            )
            .then((result) => {
              answers.push({ params: request.params, result });
              openAcks.delete(disconnect);
              clearTimeout(timer);
              resolve(result);
            });
        }),
    }),
  };
  const io = createSocketRoomDiscoveryHarness(async (room) =>
    room === target.id || room === `rpc:${owner.id}:${method}` ? [target] : [],
  );
  eventRouter.setIo(io, {
    forwardRpc: (request) => forwardRpcCall({ io, ...request }),
  });
  const custody = {
    machineId: machine.id,
    expectedCustodianAccountId: owner.id,
    expectedInstallationId: installationId,
  };
  return {
    owner,
    guests,
    machine,
    custody,
    host,
    push,
    failure,
    forwards,
    answers,
    running: () => [...tracked.values()],
    withdraw: (subjectAccountId: string) =>
      dispatchMachineAccessLossCustody({ ...custody, subjectAccountId }),
    /** The daemon's socket drops: Socket.IO rejects open ACKs and the daemon cancels its transport requests. */
    disconnect: () => {
      for (const reject of openAcks)
        reject(
          Object.assign(new Error('socket disconnected'), {
            code: 'SOCKET_DISCONNECTED',
          }),
        );
      openAcks.clear();
      rpc.cancelTransportRequests();
    },
    dispose: () => {
      lifetime.abort();
      eventRouter.clearIo();
    },
  };
}

const tracker = <T>(promise: Promise<T>) => {
  const state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
};

describe("Machine access-loss forward lives as long as the withdrawn person's admitted turn", () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-access-loss-turn-',
      initAuth: true,
      initEncrypt: false,
      initFiles: false,
      env: {
        HAPPIER_SERVER_IDENTITY_ID: 'srv_turn_boundary',
        AUTH_REQUIRED_LOGIN_PROVIDERS: '',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: String(HOME_DEFAULT_DEADLINE_MS),
      },
    });
  }, 120_000);
  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('settles on the Home when a turn that outlives the Home default deadline ends at its boundary', async () => {
    const f = await fixture();
    try {
      const guest = f.host(f.guests[0]!.id);
      f.push(guest, working);
      const outcome = f.withdraw(f.guests[0]!.id);
      const state = tracker(outcome);
      await outlivesHomeDeadline();
      // The admitted turn keeps running and the Home is still waiting for its end, not recording a timeout.
      expect(state).toEqual({ done: false });
      expect(f.running()).toContain(guest);
      f.push(guest, idle);
      expect(await outcome).toEqual({ kind: 'settled' });
      expect(f.running()).not.toContain(guest);
      // Neither the Home ACK nor the daemon arms a deadline for this cleanup.
      expect(f.forwards).toEqual([
        {
          ackDeadlineMs: 2_147_483_647,
          daemonDeadlineMs: null,
          params: { v: 1, subjectAccountId: f.guests[0]!.id },
        },
      ]);
    } finally {
      f.dispose();
    }
  });

  it('settles an idle Session at once and keeps a real cleanup failure incomplete with its cause', async () => {
    const f = await fixture();
    try {
      const guest = f.host(f.guests[0]!.id);
      expect(await f.withdraw(f.guests[0]!.id)).toEqual({ kind: 'settled' });
      expect(f.running()).not.toContain(guest);
      f.failure.resources = true;
      f.host(f.guests[1]!.id);
      expect(await f.withdraw(f.guests[1]!.id)).toEqual({
        kind: 'incomplete',
        reason: 'cleanup_incomplete',
      });
    } finally {
      f.dispose();
    }
  });

  it("does not delay another person's withdrawal behind a long turn, live or on reconnect", async () => {
    const f = await fixture();
    try {
      const [first, second] = [
        f.host(f.guests[0]!.id),
        f.host(f.guests[1]!.id),
      ];
      f.push(first, working);
      const longTurn = tracker(f.withdraw(f.guests[0]!.id));
      expect(await f.withdraw(f.guests[1]!.id)).toEqual({ kind: 'settled' });
      expect(f.running()).toEqual([first]);
      expect(longTurn.done).toBe(false);
      // Reconnect: the census names the remaining person; a second idle person settles without waiting for the first.
      const third = f.host(f.guests[1]!.id);
      f.disconnect();
      await expect.poll(() => longTurn.done).toBe(true);
      expect(longTurn.value).toEqual({
        kind: 'incomplete',
        reason: 'forward_failed:RPC_OUTCOME_UNKNOWN',
      });
      const recovered = tracker(recoverMachineAccessLossCustody(f.custody));
      await expect.poll(() => f.running()).toEqual([first]);
      expect(f.running()).not.toContain(third);
      expect(recovered.done).toBe(false);
      // The re-dispatch joined the pending end: the turn's own settle ends the Session and answers it.
      f.push(first, idle);
      await expect.poll(() => recovered.done).toBe(true);
      expect(f.running()).toEqual([]);
      expect(
        f.answers
          .filter(
            (answer) =>
              (answer.params as { subjectAccountId?: string })
                .subjectAccountId === f.guests[0]!.id,
          )
          .map((answer) => answer.result),
      ).toContainEqual({ kind: 'settled' });
    } finally {
      f.dispose();
    }
  });

  it("returns the owner's withdrawal at once while the person's turn finishes", async () => {
    const f = await fixture();
    try {
      expect(
        await inTx((tx) =>
          setMachineAccessGrantInTx(tx, {
            actorAccountId: f.owner.id,
            machineId: f.machine.id,
            principal: { kind: 'account', accountId: f.guests[0]!.id },
            level: 'view',
          }),
        ),
      ).toMatchObject({ kind: 'saved' });
      const guest = f.host(f.guests[0]!.id);
      f.push(guest, working);
      expect(
        await inTx((tx) =>
          removeMachineAccessGrantInTx(tx, {
            actorAccountId: f.owner.id,
            machineId: f.machine.id,
            principal: { kind: 'account', accountId: f.guests[0]!.id },
          }),
        ),
      ).toMatchObject({ kind: 'removed' });
      await expect.poll(() => f.forwards.length).toBe(1);
      expect(f.answers).toEqual([]);
      expect(f.running()).toContain(guest);
      f.push(guest, idle);
      await expect
        .poll(() => f.answers)
        .toEqual([
          {
            params: { v: 1, subjectAccountId: f.guests[0]!.id },
            result: { kind: 'settled' },
          },
        ]);
      expect(f.running()).toEqual([]);
    } finally {
      f.dispose();
    }
  });
});
