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
    const root = await mint('machines.managed.acquire', { homeId });
    if (typeof root === 'string') throw new Error('Bound Setup acquisition did not mint');
    const managed = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
      controllerMachineId: machine.id, controllerInstallationId: machine.installationId!,
      admittedActionRequestId: root.binding.requestId, admittedInput: { acquisitionMode: 'resource-bound' },
      allocation: 'bound', launch: { provider: { pluginId: 'fixture.setup', localId: 'vm' },
        schemaVersion: 1, name: 'Bound', choices: {} },
      resource: { contributionRef: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, value: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
    const report = { homeId, managedId: managed.id, presetId: 'setup', presetRevision: 1,
      target: { kind: 'bound', controller: { machineId: machine.id, installationId: machine.installationId! } },
      state: 'running', operation: { operationId: 'bound-setup' } };
    expect(await verify(root, 'machines.managed.acquire', 'POST', '/v1/machines/setup/report', report))
      .toEqual({ admitted: true, phase: undefined });
    for (const changed of [{ managedId: 'another-resource' }, { target: { kind: 'bound', controller: {
      machineId: 'another-controller', installationId: machine.installationId! } } },
      { target: { kind: 'bound', controller: { machineId: machine.id, installationId: 'another-installation' } } }]) {
      expect((await verify(root, 'machines.managed.acquire', 'POST', '/v1/machines/setup/report', { ...report, ...changed })).admitted)
        .toBe(false);
    }
    const spawn = await mint('session.spawn_new', { creationKey: crypto.randomUUID(),
      executionTarget: { serverId: homeId, machineId: machine.id }, directory: { kind: 'managed' },
      memoryEnabled: false, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      connectedServices: { v: 2, bindingsByServiceId: {} } });
    if (typeof spawn === 'string') throw new Error(`Bound Session spawn did not mint: ${spawn}`);
    const session = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(),
      metadata: '{}', encryptionMode: 'plain', managedCreationId: managed.id } });
    const sessionTarget = { ...report.target, sessionId: session.id };
    const installed = { homeId, managedId: managed.id, presetId: report.presetId, presetRevision: report.presetRevision,
      target: sessionTarget, bootstrapInstalled: true };
    for (const body of [installed, { ...report, target: sessionTarget }]) {
      expect(await verify(spawn, 'session.spawn_new', 'POST', '/v1/machines/setup/report', body))
        .toEqual({ admitted: true, phase: undefined });
    }
    for (const changed of [{ managedId: 'another-resource' }, { target: { ...sessionTarget, sessionId: 'another-session' } },
      { target: { ...sessionTarget, controller: { ...sessionTarget.controller, installationId: 'another-installation' } } },
      { target: report.target }]) {
      expect((await verify(spawn, 'session.spawn_new', 'POST', '/v1/machines/setup/report', { ...installed, ...changed })).admitted)
        .toBe(false);
    }
    await db.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
    expect((await verify(spawn, 'session.spawn_new', 'POST', '/v1/machines/setup/report', installed)).admitted).toBe(false);
  } finally {
    await app.close();
  }
});
