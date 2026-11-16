import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import {
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  signExternalActionMachineRpcRequestV1,
  verifyExternalActionMachineRpcRequestV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  SOCKET_RPC_EVENTS,
  type SocketRpcRequestPayload,
} from '@happier-dev/protocol/socketRpc';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { buildSessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import {
  createFakeSocket,
  createSocketRoomDiscoveryHarness,
  triggerSocketHandler,
} from '@/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket } from '@/app/api/testkit/accountStoredContentCompatibility';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { readCurrentSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';

/**
 * An approved replay of `session.permission.respond` carries the requester's
 * signed root through the CLI Session transport (cliPermissionActionDeps →
 * sessionRpc → callSocketRpc). Home admits that root once; the router consumes
 * it and routes to the Session's current publisher.
 */
describe('signed Session permission decision RPC admission', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'signed-permission-decision-',
      initAuth: true,
      env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '' },
    });
  }, 300_000);
  afterAll(async () => {
    await harness?.close();
  });

  type Requester = 'present_user' | 'terminal';

  async function fixture(
    requester: Requester,
    effectActionId: 'session.permission.respond' | 'session.message.send' = 'session.permission.respond',
  ) {
    const account = await db.account.create({
      data: { publicKey: null, encryptionMode: 'plain' },
    });
    const keys = nacl.sign.keyPair();
    const machine = await db.machine.create({
      data: {
        id: randomUUID(),
        accountId: account.id,
        installationId: randomUUID(),
        installationPublicKey: new Uint8Array(keys.publicKey),
        metadata: encodePlainMachineStoredContent({}),
        dataEncryptionKey: decodeBase64(
          MACHINE_PLAIN_DATA_KEY_MARKER,
          'base64',
        ),
      },
    });
    const session = await db.session.create({
      data: {
        accountId: account.id,
        tag: randomUUID(),
        metadata: '{}',
        encryptionMode: 'plain',
      },
    });
    await db.accessKey.create({
      data: {
        accountId: account.id,
        machineId: machine.id,
        sessionId: session.id,
        data: 'session-key',
      },
    });

    const terminal = requester === 'terminal';
    const token = await auth.createToken(
      account.id,
      undefined,
      terminal
        ? { kind: 'terminal', authority: 'account_automation' }
        : { kind: 'account', authority: 'present_user' },
    );
    const target = { kind: 'session' as const, sessionId: session.id };
    const actionInput = effectActionId === 'session.message.send' ? {
      sessionId: session.id,
      message: 'Follow up',
    } : {
      sessionId: session.id,
      requestId: 'tool-call-1',
      decision: 'allow',
    };
    const envelope = {
      v: 1 as const,
      requestId: randomUUID(),
      target,
      input: actionInput,
    };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse(
      await auth.mintExternalActionExecutionAuthorization({
        serverIdentityId: await getOrCreateServerIdentityId(),
        accountId: account.id,
        authentication: {
          kind: terminal ? 'terminal' : 'account',
          tokenEpoch: account.tokenEpoch,
        },
        actionId: effectActionId,
        machineId: machine.id,
        target,
        requestId: envelope.requestId,
        requestEnvelopeDigest:
          computeExternalActionRequestEnvelopeDigestV1(envelope),
      }),
    );
    const methodSuffix = RPC_METHODS.SESSION_PERMISSION_RESPOND;
    const params = buildSessionPermissionRespondRpcParamsV1({
      id: 'tool-call-1',
      decision: 'allow',
    });
    // sessionRpc seals the requester's own credential for this exact Session RPC purpose.
    const authorization = sealExternalActionRequesterAccountContextV1({
      authorization: root,
      credentials: { token },
      invocation: {
        caller: { kind: 'host' },
        surface: 'cli',
        authority: terminal ? 'account_automation' : 'present_user',
      },
      purpose: { kind: 'machine_rpc', method: methodSuffix, params },
      installationPublicKey: new Uint8Array(keys.publicKey),
      randomBytes: nacl.randomBytes,
    });

    const forwarded: SocketRpcRequestPayload[] = [];
    const publisher = createFakeSocket({
      id: `publisher-${requester}`,
      data: {
        clientType: 'session-scoped',
        userId: account.id,
        sessionId: session.id,
        machineId: machine.id,
      },
      timeout: () => ({
        emitWithAck: async (_event, packet: SocketRpcRequestPayload) => {
          forwarded.push(packet);
          return { ok: true };
        },
      }),
    });
    qualifyCurrentAccountStoredContentSocket(publisher);
    const presence = createSessionPublisherPresence();
    expect(
      await presence.registerPublisher({
        socket: publisher,
        binding: {
          accountId: account.id,
          sessionId: session.id,
          machineId: machine.id,
        },
        completeActivitySnapshot: { state: 'active', activeCount: 1 },
      }),
    ).toMatchObject({ status: 'registered' });
    const runtimeTarget = await readCurrentSessionInputMachineTargetInTx(db, {
      accountId: account.id,
      sessionId: session.id,
      machineId: machine.id,
    });
    await db.session.update({
      where: { id: session.id },
      data: { runtimeMachineTarget: runtimeTarget },
    });

    const method = `${session.id}:${methodSuffix}`;
    const rooms = new Map<string, readonly unknown[]>([
      [`rpc:${account.id}:${method}`, [publisher]],
      [publisher.id, [publisher]],
      [`session:${session.id}:${account.id}`, [publisher]],
    ]);
    const io = createSocketRoomDiscoveryHarness(
      async (room) => rooms.get(room) ?? [],
    );
    // The replay executor connects with the requester's own credential.
    const caller = createFakeSocket({
      id: `caller-${requester}`,
      data: {
        clientType: 'user-scoped',
        userId: account.id,
        authTokenKind: terminal ? 'terminal' : 'account',
        tokenEpoch: account.tokenEpoch,
        authAuthority: terminal ? 'account_automation' : 'present_user',
        authTokenAuthenticationEvidence: [],
      },
    });
    qualifyCurrentAccountStoredContentSocket(caller);
    registerSocketRpcHandlers({
      userId: account.id,
      socket: caller as unknown as Socket,
      io,
      sessionPublisherPresence: presence,
    });

    const signedPacket = (signingKey = keys.secretKey) => {
      const requestId = randomUUID();
      return {
        method,
        requestId,
        params,
        authorization: { kind: 'session.write', sessionId: session.id },
        externalActionExecution: {
          v: 1 as const,
          authorization,
          effectActionId,
          target,
          installationId: machine.installationId!,
          machineSignature: signExternalActionMachineRpcRequestV1({
            authorizationToken: authorization.token,
            requesterAccountContext: authorization.requesterAccountContext,
            effectActionId,
            target,
            installationId: machine.installationId!,
            event: SOCKET_RPC_EVENTS.CALL,
            method,
            requestId,
            params,
            privateKey: signingKey,
          }),
        },
      };
    };
    return {
      account,
      machine,
      session,
      caller,
      forwarded,
      method,
      params,
      signedPacket,
    };
  }

  it.each(['present_user', 'terminal'] as const)(
    'routes the approved %s replay to the Session publisher once',
    async (requester) => {
      const f = await fixture(requester);
      const ack = vi.fn();
      await triggerSocketHandler(
        f.caller,
        SOCKET_RPC_EVENTS.CALL,
        f.signedPacket(),
        ack,
      );
      expect(ack).toHaveBeenCalledWith({ ok: true, result: { ok: true } });
      expect(f.forwarded).toHaveLength(1);
      expect(f.forwarded[0]).toMatchObject({
        method: f.method,
        authorization: {
          kind: 'session.permission.respond',
          sessionId: f.session.id,
          actor: { kind: 'accountUser', accountId: f.account.id },
        },
      });
    },
  );

  it('refuses a valid signed message effect on the Session permission response method', async () => {
    const f = await fixture('present_user', 'session.message.send');
    const packet = f.signedPacket();
    const execution = packet.externalActionExecution;
    // The installation signed this exact method and mismatched effect; refusal
    // must not depend on a substituted signature or terminal credential floor.
    expect(verifyExternalActionMachineRpcRequestV1({
      authorizationToken: execution.authorization.token,
      requesterAccountContext: execution.authorization.requesterAccountContext,
      effectActionId: execution.effectActionId,
      target: execution.target,
      installationId: execution.installationId,
      event: SOCKET_RPC_EVENTS.CALL,
      method: packet.method,
      requestId: packet.requestId,
      params: packet.params,
      publicKey: f.machine.installationPublicKey!,
      signature: execution.machineSignature,
    })).toBe(true);
    const ack = vi.fn();
    await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, packet, ack);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: 'RPC_FORBIDDEN' }),
    );
    expect(f.forwarded).toEqual([]);
  });

  it('refuses an unadmitted terminal decision and a substituted installation signature', async () => {
    const f = await fixture('terminal');
    const unsigned = vi.fn();
    await triggerSocketHandler(
      f.caller,
      SOCKET_RPC_EVENTS.CALL,
      {
        method: f.method,
        requestId: randomUUID(),
        params: f.params,
        authorization: { kind: 'session.write', sessionId: f.session.id },
      },
      unsigned,
    );
    expect(unsigned).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: 'RPC_FORBIDDEN' }),
    );
    const forged = vi.fn();
    await triggerSocketHandler(
      f.caller,
      SOCKET_RPC_EVENTS.CALL,
      f.signedPacket(nacl.sign.keyPair().secretKey),
      forged,
    );
    expect(forged).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: 'RPC_FORBIDDEN' }),
    );
    expect(f.forwarded).toEqual([]);
  });
});
