import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  decodeBase64,
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
} from '@happier-dev/protocol/actions/externalActionApi';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  encodeExternalActionResolvedTargetV1,
  signExternalActionMachineRequestV1,
  signExternalActionMachineRpcRequestV1,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
  SessionPendingEnqueueByMachineRequestV1Schema,
  SessionPendingEnqueueByMachineResponseV1Schema,
} from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { auth } from '@/app/auth/auth';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { sessionRoutes } from '@/app/api/routes/session/sessionRoutes';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '@/app/api/socket/machineSocketInstallationProof';
import { resolveCurrentSessionMachineFromServer } from '@/app/api/socket/externalActionDispatcher';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import {
  createAuthenticatedFakeSocket,
  createSocketRoomDiscoveryHarness,
  triggerSocketHandler,
} from '@/app/api/testkit/socketHarness';
import {
  qualifyCurrentAccountStoredContentSocket,
  currentAccountStoredContentCompatibilityHeaders,
} from '@/app/api/testkit/accountStoredContentCompatibility';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';

// Home's database, auth and Session routes are real; only the installed
// Machine socket is substituted at the network edge.
const serverId = `srv_${randomUUID().replaceAll('-', '')}`;
let harness: LightSqliteHarness;
beforeAll(async () => {
  harness = await createLightSqliteHarness({
    tempDirPrefix: 'review-apply-session-message-',
    initAuth: true,
    initEncrypt: true,
    env: {
      HAPPIER_SERVER_IDENTITY_ID: serverId,
      AUTH_REQUIRED_LOGIN_PROVIDERS: '',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
    },
  });
}, 180_000);
afterAll(async () => {
  await harness?.close();
});

it('lets an approved Review apply read and deliver to another Session its own Account can access, and nothing else', async () => {
  const account = await db.account.create({
    data: { encryptionMode: 'plain' },
  });
  const foreignAccount = await db.account.create({
    data: { encryptionMode: 'plain' },
  });
  const keys = nacl.sign.keyPair();
  const machine = await db.machine.create({
    data: {
      id: randomUUID(),
      accountId: account.id,
      metadata: encodePlainMachineStoredContent({
        host: 'Owner',
        platform: 'linux',
        happyCliVersion: 'test',
        homeDir: '/home/owner',
        happyHomeDir: '/home/owner/.happier',
      }),
      dataEncryptionKey: Uint8Array.from(
        decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
      ),
      active: true,
      installationId: randomUUID(),
      installationPublicKey: new Uint8Array(keys.publicKey),
      operationProtocolCapabilities: {
        sessionInputAdmission: { protocolVersions: [1] },
      },
      operationProtocolCapabilitiesRevision: 1,
    },
  });
  const installationId = machine.installationId!;
  const session = (accountId: string) =>
    db.session.create({
      data: {
        accountId,
        tag: randomUUID(),
        metadata: '{}',
        encryptionMode: 'plain',
      },
    });
  const source = await session(account.id),
    destination = await session(account.id),
    foreign = await session(foreignAccount.id);
  for (const sessionId of [source.id, destination.id])
    await db.accessKey.create({
      data: {
        accountId: account.id,
        machineId: machine.id,
        sessionId,
        data: 'opaque-session-access-key',
      },
    });
  await db.session.update({
    where: { id: destination.id },
    data: {
      runtimeMachineTarget: {
        homeId: serverId,
        accountId: account.id,
        sessionId: destination.id,
        machineId: machine.id,
        installationId,
      },
    },
  });
  const publisher = createAuthenticatedFakeSocket({
    data: {
      clientType: 'session-scoped',
      userId: account.id,
      sessionId: source.id,
    },
  });
  const presence = createSessionPublisherPresence();
  await presence.registerPublisher({
    socket: publisher as unknown as Socket,
    binding: {
      accountId: account.id,
      machineId: machine.id,
      sessionId: source.id,
    },
    completeActivitySnapshot: { state: 'idle', activeCount: 0 },
  });
  const publisherIo = createSocketRoomDiscoveryHarness(async () => [publisher]);
  const resolveCurrentSessionMachine = (
    operand: Readonly<{ accountId: string; sessionId: string }>,
  ) =>
    resolveCurrentSessionMachineFromServer({
      io: publisherIo,
      presence,
      ...operand,
    });

  const target = { kind: 'machine' as const, machineId: machine.id };
  const mint = async (
    actionId: 'review.apply' | 'session.compact',
    input: unknown,
  ) => {
    const parsed = getActionSpec(actionId).inputSchema.parse(input);
    const requestId = randomUUID(),
      envelope = { v: 1 as const, requestId, target, input: parsed };
    const tokenEpoch = (
      await db.account.findUniqueOrThrow({ where: { id: account.id } })
    ).tokenEpoch;
    return auth.mintExternalActionExecutionAuthorization(
      {
        accountId: account.id,
        serverIdentityId: serverId,
        authentication: { kind: 'account', tokenEpoch },
        actionId,
        machineId: machine.id,
        target,
        requestId,
        admittedMachineRole: 'use',
        sessionActionOrigin: {
          v: 1,
          caller: {
            kind: 'session',
            sessionId: source.id,
            starterDepth: 0,
            turnDepth: 0,
          },
          sourceTurnId: 'apply-turn',
          callerPermissionMode: null,
          requestId,
        },
        sessionActionSource: { machineId: machine.id, installationId },
        requestEnvelopeDigest:
          computeExternalActionRequestEnvelopeDigestV1(envelope),
      },
      { input: parsed, resolveCurrentSessionMachine },
    );
  };
  const apply = await mint('review.apply', {
    sessionId: destination.id,
    reviewId: randomUUID(),
    commentIds: ['finding'],
  });
  const resolvedDestination = {
    kind: 'session' as const,
    sessionId: destination.id,
  };
  const headers = (
    authorization: ExternalActionExecutionAuthorizationV1,
    path: string,
    resolved: ExternalActionExecutionAuthorizationV1['binding']['target'] = resolvedDestination,
    effectActionId = 'session.message.send',
    method = 'GET',
    body?: unknown,
  ) => ({
    ...currentAccountStoredContentCompatibilityHeaders,
    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]:
      encodeExternalActionResolvedTargetV1(resolved),
    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]:
      signExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId,
        target: resolved,
        installationId,
        requestId: authorization.binding.requestId,
        method,
        path,
        body,
        privateKey: keys.secretKey,
      }),
  });

  await withAuthenticatedTestApp(
    (app) => {
      app.decorate(
        'resolveCurrentSessionMachine',
        resolveCurrentSessionMachine,
      );
      registerAccountEncryptionRoutes(app);
      sessionRoutes(app);
    },
    async (app) => {
      const currentness = '/v1/account/encryption/currentness';
      const destinationPath = `/v2/sessions/${destination.id}`,
        foreignPath = `/v2/sessions/${foreign.id}`;
      const read = (
        authorization: ExternalActionExecutionAuthorizationV1,
        path: string,
        ...rest: Parameters<typeof headers> extends [
          unknown,
          unknown,
          ...infer R,
        ]
          ? R
          : never
      ) =>
        app.inject({
          method: 'GET',
          url: path,
          headers: headers(authorization, path, ...rest),
        });

      // The two reads B3 needs, for the owner's own other Session.
      const currentnessRead = await read(apply, currentness);
      expect(currentnessRead.statusCode, currentnessRead.body).toBe(200);
      const destinationRead = await read(apply, destinationPath);
      expect(destinationRead.statusCode, destinationRead.body).toBe(200);

      // Another Account's Session is refused even as the signed resolved target.
      expect(
        (
          await read(apply, foreignPath, {
            kind: 'session',
            sessionId: foreign.id,
          })
        ).statusCode,
      ).toBe(401);
      // A read outside its resolved Session target, another effect, or another root is not this child.
      expect((await read(apply, foreignPath)).statusCode).toBe(401);
      expect(
        (
          await read(
            apply,
            currentness,
            resolvedDestination,
            'session.transcript.get',
          )
        ).statusCode,
      ).toBe(401);
      expect(
        (await read(apply, '/v1/account/encryption', resolvedDestination))
          .statusCode,
      ).toBe(401);
      const otherRoot = await mint('session.compact', {
        sessionId: destination.id,
      });
      expect((await read(otherRoot, currentness)).statusCode).toBe(401);
      expect((await read(otherRoot, destinationPath)).statusCode).toBe(401);

      // Delivery spends the same admitted root through the installed Machine socket.
      const socket = createAuthenticatedFakeSocket({
        nsp: { server: createSocketRoomDiscoveryHarness(async () => []) },
        data: {
          clientType: 'machine-scoped',
          machineId: machine.id,
          [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId,
        },
      });
      qualifyCurrentAccountStoredContentSocket(socket);
      machineUpdateHandler(account.id, socket as unknown as Socket, {
        operationSocketBatchLimits: {
          ok: true,
          limits: { maxItems: 200, maxSerializedBytes: 524_288 },
        },
        resolveCurrentSessionMachine,
      });
      const enqueue = async (
        authorization: ExternalActionExecutionAuthorizationV1,
        sessionId = destination.id,
        resolved = { kind: 'session' as const, sessionId },
      ) => {
        const body = SessionPendingEnqueueByMachineRequestV1Schema.parse({
          v: 1,
          sessionId,
          targetMachineId: machine.id,
          localId: randomUUID(),
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'Apply the finding' },
            },
          },
          requestedAction: { v: 1, kind: 'enqueue' },
        });
        const event = SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1;
        const request = {
          ...body,
          externalAction: {
            v: 1,
            authorization,
            effectActionId: 'session.message.send',
            target: resolved,
            installationId,
            machineSignature: signExternalActionMachineRpcRequestV1({
              authorizationToken: authorization.token,
              effectActionId: 'session.message.send',
              target: resolved,
              installationId,
              event,
              method: event,
              requestId: authorization.binding.requestId,
              params: body,
              privateKey: keys.secretKey,
            }),
          },
        };
        let response: unknown;
        await triggerSocketHandler(socket, event, request, (value: unknown) => {
          response = value;
        });
        return {
          localId: body.localId,
          result:
            SessionPendingEnqueueByMachineResponseV1Schema.parse(response)
              .result,
        };
      };
      const sent = await enqueue(apply);
      expect(sent.result).toEqual({
        status: 'accepted',
        localId: sent.localId,
      });
      const refused = [
        await enqueue(apply, foreign.id),
        await enqueue(otherRoot),
      ];
      for (const attempt of refused)
        expect(attempt.result).toMatchObject({ status: 'rejected' });
      expect(
        await db.sessionPendingMessage.count({
          where: { localId: { in: refused.map((attempt) => attempt.localId) } },
        }),
      ).toBe(0);

      // Withdrawing the owner sign-in ends the root at its next request.
      await db.account.update({
        where: { id: account.id },
        data: { tokenEpoch: { increment: 1 } },
      });
      expect((await read(apply, currentness)).statusCode).toBe(401);
      expect((await read(apply, destinationPath)).statusCode).toBe(401);
    },
    { authentication: 'real' },
  );
});
