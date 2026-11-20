import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  buildAccountStoredContentCompatibilitySocketAuthV1,
  decodeBase64,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  SOCKET_RPC_EVENTS,
  type SocketRpcAuthorizationContext,
} from '@happier-dev/protocol/socketRpc';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import {
  createAuthenticatedFakeSocket,
  triggerSocketHandler,
} from '../../testkit/socketHarness';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';
import { buildRpcMethodRoom } from './rpcMethodRoom';
import { authorizeMachineRpcRequest } from '../../../../../../cli/src/api/machine/machineRpcAuthorization';

const accountStoredContentCompatibility =
  evaluateAccountStoredContentSocketCompatibility(
    buildAccountStoredContentCompatibilitySocketAuthV1(
      CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    ),
  ).evaluation;

type Role = 'owner' | 'sharedReader' | 'useOnly';

/**
 * Child-agent rosters and transcripts are Session content served by the Machine
 * custodian's daemon. A Machine Use grant must not stand in for Session access:
 * Home admits the caller on the named Session once, and the daemon binds the
 * decoded body to that admission. Only the socket transport is replaced.
 */
describe('sessions.subagents machine RPC Session admission', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-subagent-rpc-',
      initAuth: true,
    });
  }, 180_000);
  afterAll(async () => {
    await harness?.close();
  });

  async function fixture(role: Role) {
    const custodian = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const member = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const actor = role === 'owner' ? custodian : member;
    const session = await db.session.create({
      data: {
        accountId: custodian.id,
        tag: randomUUID(),
        encryptionMode: 'plain',
        metadata: '{}',
      },
    });
    const otherSession = await db.session.create({
      data: {
        accountId: custodian.id,
        tag: randomUUID(),
        encryptionMode: 'plain',
        metadata: '{}',
      },
    });
    const machine = await db.machine.create({
      data: {
        id: randomUUID(),
        accountId: custodian.id,
        installationId: randomUUID(),
        active: true,
        metadata: encodePlainMachineStoredContent({
          host: 'host',
          platform: 'linux',
          happyCliVersion: 'test',
          homeDir: '/home/custodian',
          happyHomeDir: '/home/custodian/.happier',
        }),
        dataEncryptionKey: new Uint8Array(
          decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        ),
        operationProtocolCapabilities: {
          requesterExecutionIsolation: { protocolVersions: [1] },
          sessionInputAdmission: { protocolVersions: [1, 2] },
        },
        operationProtocolCapabilitiesRevision: 1,
      },
    });
    await inTx((tx) =>
      setEligibleMachineAccessGrantInTx(tx, {
        actorAccountId: custodian.id,
        machineId: machine.id,
        principal: { kind: 'account', accountId: member.id },
        level: 'view',
      }),
    );
    if (role === 'sharedReader') {
      await db.sessionGrant.create({
        data: {
          principalKind: 'account',
          sessionId: session.id,
          createdByAccountId: custodian.id,
          accountId: member.id,
          accessLevel: 'view',
        },
      });
    }
    const effects: string[] = [];
    let decodedInput: Record<string, unknown> = {};
    // The production daemon gate consumes Home's packet; the handler effect is recorded only when it admits.
    const emitWithAck = vi.fn(
      async (
        _event: string,
        packet: {
          method: string;
          authorization?: SocketRpcAuthorizationContext;
          machineAdmission?: SocketRpcMachineAdmissionContextV1;
        },
      ) => {
        const admitted = await authorizeMachineRpcRequest(
          { ...packet, params: decodedInput },
          {
            machineId: machine.id,
            resolveInstallationId: () => machine.installationId,
            resolveCustodianAccountId: async () => custodian.id,
            resolveHomeServerIdentityId: async () => 'home',
            verifyMachineAdmission: async () => true,
          },
          'authenticated_home_socket',
        );
        if (!admitted.ok) return { ok: false, errorCode: admitted.errorCode };
        effects.push(packet.method.slice(packet.method.lastIndexOf(':') + 1));
        return { ok: true };
      },
    );
    const target = {
      id: randomUUID(),
      connected: true,
      data: {
        clientType: 'machine-scoped',
        machineId: machine.id,
        verifiedMachineInstallationId: machine.installationId,
        accountStoredContentCompatibility,
      },
      timeout: () => ({ emitWithAck }),
    };
    const io = new Server();
    io.sockets.sockets.set(target.id, target as unknown as Socket);
    const caller = createAuthenticatedFakeSocket({
      id: randomUUID(),
      data: { clientType: 'user-scoped', accountStoredContentCompatibility },
    });
    registerSocketRpcHandlers({
      userId: actor.id,
      socket: caller as unknown as Socket,
      io,
    });
    const invoke = async (
      rpcMethod: string,
      input: Record<string, unknown>,
      authorization?: SocketRpcAuthorizationContext,
    ) => {
      decodedInput = input;
      const method = `${machine.id}:${rpcMethod}`;
      io.sockets.adapter.rooms.set(
        buildRpcMethodRoom({ userId: custodian.id, method }),
        new Set([target.id]),
      );
      const callback = vi.fn();
      await triggerSocketHandler(
        caller,
        SOCKET_RPC_EVENTS.CALL,
        {
          method,
          params: 'opaque-request',
          ...(authorization ? { authorization } : {}),
        },
        callback,
      );
      expect(callback).toHaveBeenCalledOnce();
      return callback.mock.calls[0]![0];
    };
    return {
      session,
      otherSession,
      effects,
      invoke,
      close: () => io.sockets.sockets.clear(),
    };
  }

  const reads = [
    [
      RPC_METHODS.SESSIONS_SUBAGENTS_LIST,
      (sessionId: string) => ({ sessionId }),
    ],
    [
      RPC_METHODS.SESSIONS_SUBAGENTS_GET,
      (sessionId: string) => ({ sessionId, entryId: 'entry', toolId: 'tool' }),
    ],
    [
      RPC_METHODS.SESSIONS_SUBAGENTS_WATCH,
      (parentSessionId: string) => ({ parentSessionId }),
    ],
  ] as const;
  const writes = [
    [
      RPC_METHODS.SESSIONS_SUBAGENTS_UPSERT,
      (parentSessionId: string) => ({
        id: 'child',
        parentSessionId,
        origin: 'plugin',
        kind: 'custom',
      }),
    ],
    [
      RPC_METHODS.SESSIONS_SUBAGENTS_UPDATE_STATUS,
      (parentSessionId: string) => ({
        id: 'child',
        parentSessionId,
        status: 'running',
      }),
    ],
    [
      RPC_METHODS.SESSIONS_SUBAGENTS_COMPLETE,
      (parentSessionId: string) => ({
        id: 'child',
        parentSessionId,
        status: 'completed',
      }),
    ],
  ] as const;

  it('refuses a Machine Use grantee without access to the Session', async () => {
    const { session, effects, invoke, close } = await fixture('useOnly');
    try {
      for (const [method, input] of [...reads, ...writes]) {
        const unscoped = await invoke(method, input(session.id));
        expect(unscoped, method).not.toMatchObject({
          ok: true,
          result: { ok: true },
        });
        const kind = reads.some(([read]) => read === method)
          ? 'session.read'
          : 'session.write';
        const claimed = await invoke(method, input(session.id), {
          kind,
          sessionId: session.id,
        });
        expect(claimed, method).not.toMatchObject({
          ok: true,
          result: { ok: true },
        });
      }
      expect(effects).toEqual([]);
    } finally {
      close();
    }
  });

  it.each(['owner', 'sharedReader'] as const)(
    'admits Session readers on the admitted Session only (%s)',
    async (role) => {
      const { session, otherSession, effects, invoke, close } =
        await fixture(role);
      try {
        for (const [method, input] of reads) {
          expect(
            await invoke(method, input(session.id), {
              kind: 'session.read',
              sessionId: session.id,
            }),
            method,
          ).toMatchObject({ ok: true, result: { ok: true } });
          // The daemon binds the decoded body to Home's admitted Session.
          expect(
            await invoke(method, input(otherSession.id), {
              kind: 'session.read',
              sessionId: session.id,
            }),
            method,
          ).toMatchObject({ ok: true, result: { ok: false } });
        }
        expect(effects).toEqual(reads.map(([method]) => method));
        effects.length = 0;
        for (const [method, input] of writes) {
          const result = await invoke(method, input(session.id), {
            kind: 'session.write',
            sessionId: session.id,
          });
          if (role === 'owner')
            expect(result, method).toMatchObject({
              ok: true,
              result: { ok: true },
            });
          else
            expect(result, method).not.toMatchObject({
              ok: true,
              result: { ok: true },
            });
        }
        expect(effects).toEqual(
          role === 'owner' ? writes.map(([method]) => method) : [],
        );
      } finally {
        close();
      }
    },
  );
});
