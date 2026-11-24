import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { Server } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import {
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

/**
 * Home relay refusals of Machine admission: the admission owner's typed cause
 * reaches a requester who holds a grant, while a requester without access still
 * cannot tell an existing Machine from a missing one.
 */
describe('Home relay Machine admission refusal cause', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-machine-admission-refusal-',
      initAuth: true,
      env: {
        AUTH_REQUIRED_LOGIN_PROVIDERS: '',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
      },
    });
  }, 120_000);
  afterEach(async () => {
    await db.machine.deleteMany();
    await db.account.deleteMany();
  });
  afterAll(async () => {
    await harness.close();
  });

  async function fixture() {
    const custodian = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const requester = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const machine = await db.machine.create({
      data: {
        id: crypto.randomUUID(),
        accountId: custodian.id,
        metadata: encodePlainMachineStoredContent({
          host: 'shared',
          platform: 'linux',
          happyCliVersion: 'test',
          homeDir: '/home/shared',
          happyHomeDir: '/home/shared/.happier',
        }),
        dataEncryptionKey: decodeBase64(
          MACHINE_PLAIN_DATA_KEY_MARKER,
          'base64',
        ),
        installationId: crypto.randomUUID(),
        installationPublicKey: new Uint8Array(
          tweetnacl.sign.keyPair().publicKey,
        ),
        active: true,
        lastActiveAt: new Date(),
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: {
          externalActionExecutionAuthorization: { protocolVersions: [1] },
        },
      },
    });
    const token = await auth.createToken(requester.id, undefined, {
      kind: 'account',
      authority: 'present_user',
    });
    return { custodian, requester, machine, token };
  }

  async function withApp<T>(run: (app: AppFastify) => Promise<T>): Promise<T> {
    const io = new Server();
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed =
      app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    registerExternalActionRoutes(typed, {
      dispatch: createExternalActionDaemonDispatcher({ io }),
    });
    io.attach(typed.server);
    await typed.ready();
    try {
      return await run(typed);
    } finally {
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      await typed.close();
    }
  }

  function uninstall(app: AppFastify, token: string, machineId: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/actions/machines.agents.uninstall',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        v: 1,
        requestId: 'refusal-request',
        target: { kind: 'machine', machineId },
        input: { machineId, agentId: 'codex' },
      },
    });
  }

  it('keeps an inaccessible Machine indistinguishable from a missing one', async () => {
    const { machine, token } = await fixture();
    await withApp(async (app) => {
      const existing = await uninstall(app, token, machine.id);
      const missingId = `missing-${crypto.randomUUID()}`;
      const missing = await uninstall(app, token, missingId);
      expect(existing.statusCode).toBe(200);
      expect(existing.json()).toMatchObject({
        execution: { ok: false, errorCode: 'target_not_local' },
      });
      expect(existing.json().execution).not.toHaveProperty('failureCause');
      // Byte-equal apart from the requested Machine id the requester supplied.
      expect(missing.statusCode).toBe(existing.statusCode);
      expect(missing.body.replaceAll(missingId, machine.id)).toBe(
        existing.body,
      );
    });
  });

  it('carries the admission owner cause to a Use grantee refused an Action that needs Manage', async () => {
    const { custodian, requester, machine, token } = await fixture();
    const granted = await inTx((tx) =>
      setEligibleMachineAccessGrantInTx(tx, {
        actorAccountId: custodian.id,
        machineId: machine.id,
        principal: { kind: 'account', accountId: requester.id },
        level: 'view',
      }),
    );
    expect(granted.kind).toBe('saved');
    await withApp(async (app) => {
      const refused = await uninstall(app, token, machine.id);
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toMatchObject({
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          failureCause: {
            phase: 'execution_authorization',
            errorCode: 'machine_manage_required',
          },
        },
      });
    });
  });

  it('keeps an unavailable granted Machine on its existing unavailability result', async () => {
    const { custodian, requester, machine, token } = await fixture();
    const granted = await inTx((tx) =>
      setEligibleMachineAccessGrantInTx(tx, {
        actorAccountId: custodian.id,
        machineId: machine.id,
        principal: { kind: 'account', accountId: requester.id },
        level: 'admin',
      }),
    );
    expect(granted.kind).toBe('saved');
    await db.machine.update({
      where: { id: machine.id },
      data: { installationId: null },
    });
    await withApp(async (app) => {
      const refused = await uninstall(app, token, machine.id);
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toMatchObject({
        execution: { ok: false, errorCode: 'target_unavailable',
          details: { reason: 'machine_installation_missing' } },
      });
      expect(refused.json().execution).not.toHaveProperty('failureCause');
    });
  });
});
