import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import type { Server } from 'socket.io';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import {
  createExternalActionDaemonDispatcher,
  type ExternalActionForwardRpcCall,
} from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
import {
  removeMachineAccessGrantInTx,
  resolveMachineAdmission,
} from '@/app/machines/machineAccess';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

// L12-AUTH-REPLAY-1111 L1: a person-presented retained root is new work at the
// next request, so it must not outlive the presenter's Machine grant.
let harness: LightSqliteHarness;
beforeAll(async () => {
  harness = await createLightSqliteHarness({
    tempDirPrefix: 'root-replay-revocation-',
    initAuth: true,
    env: {
      AUTH_REQUIRED_LOGIN_PROVIDERS: '',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
    },
  });
}, 120_000);
afterAll(async () => {
  await harness?.close();
});

it("refuses a retained Bot-template root replayed after the presenter's Machine grant was removed", async () => {
  const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
  const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
  const machine = await db.machine.create({
    data: {
      id: crypto.randomUUID(),
      accountId: owner.id,
      active: true,
      metadata: encodePlainMachineStoredContent({
        host: 'shared',
        platform: 'linux',
        happyCliVersion: 'test',
        homeDir: '/home/shared',
        happyHomeDir: '/home/shared/.happier',
      }),
      dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
      installationId: crypto.randomUUID(),
      installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey),
      operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: {
        externalActionExecutionAuthorization: { protocolVersions: [1] },
      },
    },
  });
  expect(
    await inTx((tx) =>
      setEligibleMachineAccessGrantInTx(tx, {
        actorAccountId: owner.id,
        machineId: machine.id,
        principal: { kind: 'account', accountId: guest.id },
        level: 'view',
      }),
    ),
  ).toMatchObject({ kind: 'saved' });
  const session = await db.session.create({
    data: { tag: crypto.randomUUID(), accountId: guest.id, metadata: 'bot' },
  });

  // The daemon transport is the system boundary; Home's admission and relay run for real.
  const forwarded: unknown[] = [];
  const forwardRpc = (async (request: unknown) => {
    forwarded.push(request);
    return {
      ok: false,
      error: 'daemon_boundary',
      errorCode: 'daemon_boundary',
    };
  }) as unknown as ExternalActionForwardRpcCall;
  const app = Fastify({ logger: false }) as unknown as AppFastify;
  enableAuthentication(app);
  registerExternalActionRoutes(app, {
    dispatch: createExternalActionDaemonDispatcher({
      io: { to: () => ({ emit: () => undefined }) } as unknown as Server,
      forwardRpc,
    }),
  });
  const token = await auth.createToken(guest.id, undefined, {
    kind: 'account',
    authority: 'present_user',
  });
  const actionId = 'template.updates.skip';
  const envelope = {
    v: 1 as const,
    requestId: crypto.randomUUID(),
    target: { kind: 'machine' as const, machineId: machine.id },
    input: {
      sessionRef: {
        serverId: await getOrCreateServerIdentityId(),
        sessionId: session.id,
      },
      version: '1.0.0',
    },
  };
  try {
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/actions/${actionId}/execution-authorization`,
      headers: { authorization: `Bearer ${token}` },
      payload: { v: 1, machineId: machine.id, envelope },
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse(
      issued.json(),
    );
    const execute = () =>
      app.inject({
        method: 'POST',
        url: `/v1/actions/${actionId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          v: 1,
          machineId: machine.id,
          envelope,
          executionAuthorization: root,
        },
      });

    await execute();
    expect(forwarded).toHaveLength(1);

    await inTx((tx) =>
      removeMachineAccessGrantInTx(tx, {
        actorAccountId: owner.id,
        machineId: machine.id,
        principal: { kind: 'account', accountId: guest.id },
      }),
    );
    expect(
      await resolveMachineAdmission({
        actorAccountId: guest.id,
        machineId: machine.id,
      }),
    ).not.toMatchObject({ kind: 'admitted' });

    // The same root and envelope, presented again by the person, is a new request.
    await execute();
    expect(forwarded).toHaveLength(1);
  } finally {
    await app.close();
  }
});
