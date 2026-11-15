import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
  encodeExternalActionResolvedTargetV1,
  signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';

let harness: LightSqliteHarness;
beforeAll(async () => {
  harness = await createLightSqliteHarness({
    tempDirPrefix: 'happier-domain-purpose-refusal-',
    initAuth: true,
    env: {
      AUTH_REQUIRED_LOGIN_PROVIDERS: '',
      AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
    },
  });
}, 120_000);
afterAll(async () => {
  await harness?.close();
});

it('names the refusing reviewed-purpose check without changing admission', async () => {
  const account = await db.account.create({
    data: { publicKey: null, encryptionMode: 'plain' },
  });
  const keys = tweetnacl.sign.keyPair();
  const machine = await db.machine.create({
    data: {
      id: crypto.randomUUID(),
      accountId: account.id,
      metadata: encodePlainMachineStoredContent({
        host: 'controller',
        platform: 'linux',
        happyCliVersion: 'test',
        homeDir: '/home/controller',
        happyHomeDir: '/home/controller/.happier',
      }),
      metadataVersion: 1,
      dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
      daemonState: null,
      daemonStateVersion: 0,
      installationId: crypto.randomUUID(),
      installationPublicKey: new Uint8Array(keys.publicKey),
    },
  });
  const token = await auth.createToken(account.id, undefined, {
    kind: 'account',
    authority: 'present_user',
  });
  const homeId = await getOrCreateServerIdentityId();
  const app = Fastify().withTypeProvider<ZodTypeProvider>() as AppFastify;
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  enableAuthentication(app);
  registerExternalActionRoutes(app, {
    dispatch: async () => ({
      kind: 'placement_error',
      code: 'target_unavailable',
    }),
  });
  const mint = async (actionId: string, input: unknown) => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({
      v: 1,
      requestId: crypto.randomUUID(),
      target: { kind: 'machine', machineId: machine.id },
      input,
    });
    const minted = await app.inject({
      method: 'POST',
      url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
      headers: { authorization: `Bearer ${token}` },
      payload: { v: 1, machineId: machine.id, envelope },
    });
    return minted.statusCode === 200
      ? ExternalActionExecutionAuthorizationV1Schema.parse(minted.json())
      : minted.body;
  };
  const verify = async (
    root: Exclude<Awaited<ReturnType<typeof mint>>, string>,
    effectActionId: string,
    method: string,
    path: string,
    body: unknown,
  ) => {
    let phase: string | undefined;
    const result = await verifyExternalActionDomainExecutionRequest({
      authorizationToken: root.token,
      effectActionId,
      encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target),
      method,
      path,
      body,
      machineSignature: signExternalActionMachineRequestV1({
        authorizationToken: root.token,
        effectActionId,
        target: root.binding.target,
        installationId: machine.installationId!,
        requestId: root.binding.requestId,
        method,
        path,
        body,
        privateKey: keys.secretKey,
      }),
      onRefusal: (refused) => {
        phase = refused;
      },
    });
    return { admitted: result !== null, phase };
  };
  const target = { homeId, managedId: 'retained-managed' };
  const machineTarget = { serverId: homeId, machineId: machine.id };
  const machinePath = `/v1/machines/${encodeURIComponent(machine.id)}`;
  const runNow = { automationId: 'automation_123' };
  // Each row is one existing branch of the reviewed-purpose verifier: the
  // request stays admitted or refused exactly as before, and a refusal now
  // names the check that refused it.
  const rows: ReadonlyArray<
    readonly [
      actionId: string,
      input: unknown,
      method: string,
      path: string,
      body: unknown,
      expected: Readonly<{ admitted: true } | { admitted: false; phase: string }>,
    ]
  > = [
    ['machines.managed.birth.get', target, 'POST', '/v1/machines/managed/actions/birth.get', target, { admitted: true }],
    ['machines.managed.birth.get', target, 'POST', '/v2/sessions', {}, { admitted: false, phase: 'managed_machine_purpose' }],
    ['machines.managed.acquire', { homeId }, 'POST', '/v2/sessions', {}, { admitted: false, phase: 'managed_acquire_resource' }],
    ['machines.access.prepareKeys', machineTarget, 'GET', machinePath, undefined, { admitted: true }],
    ['machines.access.prepareKeys', machineTarget, 'POST', `${machinePath}/data-key-envelopes`, {},
      { admitted: false, phase: 'machine_access_key_preparation' }],
    ['machines.access.grants.list', machineTarget, 'GET', `${machinePath}/data-key-envelopes`, undefined,
      { admitted: false, phase: 'machine_access_key_preparation' }],
    ['machines.access.prepareKeys', machineTarget, 'GET', '/v1/elsewhere', undefined,
      { admitted: false, phase: 'machine_access_transport' }],
    ['workflow.trigger.run_now', runNow, 'POST', '/v3/automations/automation_123/run-now', undefined, { admitted: true }],
    ['workflow.trigger.run_now', runNow, 'GET', '/v3/automations/automation_123/run-now', undefined,
      { admitted: false, phase: 'automation_run_now_request' }],
    ['workflow.trigger.run_now', runNow, 'POST', '/v3/automations/%E0%A4%A/run-now', undefined,
      { admitted: false, phase: 'automation_run_now_request' }],
    ['workflow.trigger.run_now', runNow, 'POST', '/v3/automations/automation_456/run-now', undefined,
      { admitted: false, phase: 'automation_run_now_target' }],
    ['discussion.candidates.list', {}, 'GET', '/v1/elsewhere', undefined,
      { admitted: false, phase: 'discussion_candidate_purpose' }],
  ];
  try {
    for (const [actionId, input, method, path, body, expected] of rows) {
      const root = await mint(actionId, input);
      if (typeof root === 'string') throw new Error(`${actionId} did not mint: ${root}`);
      expect.soft({ actionId, method, path, ...(await verify(root, actionId, method, path, body)) })
        .toEqual({ actionId, method, path, ...expected });
    }
  } finally {
    await app.close();
  }
});
