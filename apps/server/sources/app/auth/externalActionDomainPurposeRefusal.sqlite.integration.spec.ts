import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
  encodeExternalActionResolvedTargetV1,
  signExternalActionMachineRequestV1,
  signExternalActionMachineRpcRequestV1,
} from '@happier-dev/protocol/actions';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest, verifyExternalActionMachineRpcExecution } from '@/app/auth/externalActionExecutionAuthorization';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { SESSION_DATA_KEY_ENVELOPE_BYTES_V1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { PROJECT_DEFINITION_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectDefinitionActionIdsV1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';

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

async function createFixture() {
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
    signer?: Readonly<{ privateKey: Uint8Array; resolveCurrentSessionMachine: () => Promise<string> }>,
  ) => {
    let phase: string | undefined;
    const result = await verifyExternalActionDomainExecutionRequest({
      authorizationToken: root.token,
      effectActionId,
      encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target),
      method,
      path,
      body,
      resolveCurrentSessionMachine: signer?.resolveCurrentSessionMachine,
      machineSignature: signExternalActionMachineRequestV1({
        authorizationToken: root.token,
        effectActionId,
        target: root.binding.target,
        installationId: machine.installationId!,
        requestId: root.binding.requestId,
        method,
        path,
        body,
        privateKey: signer?.privateKey ?? keys.secretKey,
      }),
      onRefusal: (refused) => {
        phase = refused;
      },
    });
    return { admitted: result !== null, phase };
  };
  return { account, app, homeId, keys, machine, mint, verify };
}

it('admits setup autostart placement reads under the original prepare root without granting config writes', async () => {
  const { app, homeId, machine, mint, verify } = await createFixture();
  try {
    // Captured READY-bed shape: setup settles, then its automatic Service child
    // retains projects.prepare as the signed root for placement preparation.
    const workspace = { serverId: homeId, machineId: machine.id, workspaceId: crypto.randomUUID(), rootPath: '/qa/autostart' };
    const root = await mint('projects.prepare', { workspace, phase: 'setup' });
    if (typeof root === 'string') throw new Error(`Prepare did not mint: ${root}`);
    expect(await verify(root, root.binding.actionId, 'GET', '/v1/account/encryption', undefined))
      .toEqual({ admitted: true, phase: undefined });
    const address = { serverId: homeId, refId: workspace.workspaceId };
    expect(await verify(root, root.binding.actionId, 'POST', `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, { address }))
      .toEqual({ admitted: true, phase: undefined });
    expect((await verify(root, root.binding.actionId, 'POST', `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/mutate`, {
      address, expectedRevision: 'absent', content: null,
    })).admitted).toBe(false);
    expect((await verify(root, root.binding.actionId, 'GET', '/v1/account/profile', undefined)).admitted).toBe(false);
  } finally {
    await app.close();
  }
});

async function createBoundManagedMachine({ account, homeId, machine, mint }: Awaited<ReturnType<typeof createFixture>>) {
  const root = await mint('machines.managed.acquire', { homeId });
  if (typeof root === 'string') throw new Error('Bound Setup acquisition did not mint');
  const managed = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
    controllerMachineId: machine.id, controllerInstallationId: machine.installationId!,
    admittedActionRequestId: root.binding.requestId, admittedInput: { acquisitionMode: 'resource-bound' },
    allocation: 'bound', launch: { provider: { pluginId: 'fixture.setup', localId: 'vm' },
      schemaVersion: 1, name: 'Bound', choices: {} },
    resource: { contributionRef: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, value: {} },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
  return { managed, root };
}

it('retains reviewed-purpose refusals and admitted requester reads', async () => {
  const fixture = await createFixture();
  const { account, app, homeId, keys, machine, mint, verify } = fixture;
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
    ['workflow.validate', { definition: { version: 1, blocks: [{ kind: 'wait', id: 'review',
      document: { text: 'Review', references: [], attachments: [] } }] }, target: { machineId: machine.id } },
      'GET', '/v1/machines', undefined, { admitted: true }],
    ['widgets.catalog.list', { surface: { serverId: homeId, accountId: account.id, owner: { kind: 'home' } } },
      'GET', '/v1/machines', undefined, { admitted: true }],
    ['widgets.catalog.list', { surface: { serverId: homeId, accountId: account.id, owner: { kind: 'home' } } },
      'POST', '/v1/plugins/availability/materializations/read', {}, { admitted: true }],
    ['sessions.external.candidates.list', { machineId: machine.id, agentId: 'codex', source: { kind: 'codexHome', home: 'user' }, limit: 10 },
      'GET', '/v1/account/encryption/currentness', undefined, { admitted: true }],
    ['sessions.external.candidates.list', { machineId: machine.id, agentId: 'codex', source: { kind: 'codexHome', home: 'user' }, limit: 10 },
      'POST', '/v2/sessions/lookup-by-tags', { tags: ['candidate'], matchExternalIdentity: true }, { admitted: true }],
    ['sessions.external.candidates.list', { machineId: machine.id, agentId: 'codex', source: { kind: 'codexHome', home: 'user' }, limit: 10 },
      'POST', '/v2/sessions', {}, { admitted: false, phase: 'verification_purpose' }],
    ['machines.list', { serverId: homeId }, 'GET', '/v1/machines', undefined, { admitted: true }],
    // Present-user read roots signed by the requester's own Machine use the
    // canonical admitted-read rule; the eventual HTTP route retains access.
    ['machines.list', { serverId: homeId }, 'GET', '/v1/elsewhere', undefined, { admitted: true }],
    ['machines.replacement.set', { ...machineTarget, replacementMachineId: 'replacement' }, 'POST', `${machinePath}/replacement`,
      { replacementMachineId: 'replacement' }, { admitted: true }],
    ['machines.replacement.set', { ...machineTarget, replacementMachineId: 'replacement' }, 'POST', '/v1/machines/another-machine/replacement',
      { replacementMachineId: 'replacement' }, { admitted: false, phase: 'verification_purpose' }],
    ['machines.replacement.clear', machineTarget, 'DELETE', `${machinePath}/replacement`, undefined, { admitted: true }],
    ['machines.remove', machineTarget, 'POST', `${machinePath}/revoke`, {}, { admitted: true }],
    ['machines.remove', machineTarget, 'POST', '/v1/machines/another-machine/revoke', {}, { admitted: false, phase: 'verification_purpose' }],
    ['machines.reboot', { ...machineTarget, expectedInstallationId: machine.installationId }, 'GET', machinePath, undefined, { admitted: true }],
    ['machines.reboot', { ...machineTarget, expectedInstallationId: machine.installationId }, 'GET',
      `/v1/deployments/machine-references?homeId=${encodeURIComponent(homeId)}&machineId=${encodeURIComponent(machine.id)}`,
      undefined, { admitted: true }],
    ['machines.reboot', { ...machineTarget, expectedInstallationId: machine.installationId }, 'GET',
      `/v1/deployments/machine-references?homeId=${encodeURIComponent(homeId)}&machineId=another-machine`,
      undefined, { admitted: false, phase: 'verification_purpose' }],
    ['machines.managed.references.get', target, 'POST', '/v1/machines/managed/actions/get', target, { admitted: true }],
    ['machines.managed.references.get', target, 'POST', machinePoolActionEndpointPathV1('machines.pools.list'), {}, { admitted: true }],
    ['machines.managed.references.get', target, 'GET',
      `/v1/deployments/machine-references?homeId=${encodeURIComponent(homeId)}&machineId=${encodeURIComponent(machine.id)}`,
      undefined, { admitted: true }],
    ['machines.managed.birth.get', target, 'POST', '/v1/machines/managed/actions/birth.get', target, { admitted: true }],
    ['machines.managed.birth.get', target, 'POST', '/v2/sessions', {}, { admitted: false, phase: 'managed_machine_purpose' }],
    ['machines.managed.acquire', { homeId }, 'POST', '/v2/sessions', {}, { admitted: false, phase: 'managed_acquire_resource' }],
    ['machines.access.prepareKeys', machineTarget, 'GET', machinePath, undefined, { admitted: true }],
    ['machines.access.prepareKeys', machineTarget, 'GET', `${machinePath}/content-key/transition`, undefined, { admitted: true }],
    ['machines.access.grants.list', machineTarget, 'GET', `${machinePath}/content-key/transition`, undefined,
      { admitted: true }],
    ['machines.access.prepareKeys', machineTarget, 'POST', `${machinePath}/data-key-envelopes`, {},
      { admitted: false, phase: 'machine_access_key_preparation' }],
    ['machines.access.grants.list', machineTarget, 'GET', `${machinePath}/data-key-envelopes`, undefined,
      { admitted: true }],
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
      { admitted: true }],
  ];
  try {
    for (const [actionId, input, method, path, body, expected] of rows) {
      const root = await mint(actionId, input);
      if (typeof root === 'string') throw new Error(`${actionId} did not mint: ${root}`);
      expect.soft({ actionId, method, path, ...(await verify(root, actionId, method, path, body)) })
        .toEqual({ actionId, method, path, ...expected });
    }
    // Source sharing prepares its protected setup through the original signed
    // root. The receiving Source/Artifact owners still admit every selected record.
    const sourceUpdate = await mint('projects.sources.update', { serverId: homeId,
      sourceId: 'selected-source', expectedRevision: 1, patch: { audience: [] } });
    if (typeof sourceUpdate === 'string') throw new Error(`Source update did not mint: ${sourceUpdate}`);
    const selectedSource = `/v1/projects/sources/selected-source?serverId=${encodeURIComponent(homeId)}`;
    const scopedArtifact = '/v1/artifacts/setup?projectSourceId=selected-source';
    const publicationPatch = encodeURIComponent(JSON.stringify({ audience: [] }));
    const census = `/v1/artifacts/setup/access/recipients?projectSourceId=selected-source&projectSourcePatch=${publicationPatch}`;
    for (const path of [selectedSource, scopedArtifact, census, '/v1/account/encryption/currentness']) {
      expect((await verify(sourceUpdate, 'projects.sources.update', 'GET', path, undefined)).admitted).toBe(true);
    }
    const envelopeCommit = { artifactId: 'setup', projectSourceId: 'selected-source', projectSourcePatch: { audience: [] },
      expectedDataEncryptionKey: encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1)), recipientKeyEnvelopes: [] };
    expect((await verify(sourceUpdate, 'projects.sources.update', 'POST',
      '/v1/artifacts/setup/access/key-envelopes', envelopeCommit)).admitted).toBe(true);
    expect((await verify(sourceUpdate, 'projects.sources.update', 'POST',
      '/v1/artifacts/other/access/key-envelopes', envelopeCommit)).admitted).toBe(false);
    for (const path of ['/v1/artifacts/setup', `${scopedArtifact}&unexpected=true`,
      `${scopedArtifact}&projectSourceId=other`, '/v1/artifacts/setup/access/grants',
      '/v1/artifacts/setup/access/recipients?projectSourceId=selected-source&projectSourcePatch=%7B%22name%22%3A%22wrong%22%7D']) {
      expect((await verify(sourceUpdate, 'projects.sources.update', 'GET', path, undefined)).admitted).toBe(false);
    }
    expect((await verify(sourceUpdate, 'artifact.access.grants.set', 'GET', census, undefined)).admitted).toBe(false);
    const inspect = await mint('projects.inspect', { workspace: { id: 'workspace', serverId: homeId,
      machineId: machine.id, rootPath: '/tmp/project', createdAtMs: 1 } });
    if (typeof inspect === 'string') throw new Error(`Project inspect did not mint: ${inspect}`);
    for (const path of [selectedSource, scopedArtifact, '/v1/artifacts/accepted-setup']) {
      expect((await verify(inspect, 'projects.inspect', 'GET', path, undefined)).admitted).toBe(true);
    }
    expect((await verify(inspect, 'projects.inspect', 'GET', census, undefined)).admitted).toBe(false);
    const setupInput = { projectRef: { serverId: homeId, projectKey: 'project' },
      workspace: { serverId: homeId, workspaceId: 'workspace', machineId: machine.id, rootPath: '/tmp/project' },
      expectedRevision: 'absent', intent: { kind: 'accept', sourceId: 'selected-source' } };
    const setup = await mint('projects.setup.set', setupInput);
    if (typeof setup === 'string') throw new Error(`Project setup did not mint: ${setup}`);
    for (const [effect, path] of [['projects.sources.read', selectedSource],
      ['artifact.get', scopedArtifact], ['artifact.get', '/v1/artifacts/accepted-setup']] as const) {
      expect((await verify(setup, effect, 'GET', path, undefined)).admitted).toBe(true);
    }
    const acceptedDetail = { id: crypto.randomUUID(), kind: PROJECT_SETUP_ARTIFACT_STORED_KIND_V1,
      header: '{}', body: '{}', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
    expect((await verify(setup, 'artifact.create', 'POST', '/v1/artifacts', acceptedDetail)).admitted).toBe(true);
    expect((await verify(setup, 'artifact.create', 'POST', '/v1/artifacts', { ...acceptedDetail, kind: 'doc' })).admitted).toBe(false);
    expect((await verify(setup, 'artifact.update', 'POST', '/v1/artifacts/accepted-setup', {})).admitted).toBe(false);
    expect((await verify(setup, 'artifact.get', 'GET', census, undefined)).admitted).toBe(false);
    const setupEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: setup.binding.requestId,
      target: { kind: 'machine', machineId: machine.id }, input: setupInput });
    const inspectMethod = `${machine.id}:${PROJECT_DEFINITION_ACTION_RPC_METHODS_V1['projects.inspect']}`;
    const inspectRepository = { workspace: setupInput.workspace, read: { kind: 'editor', target: 'repository' } };
    const verifySetupInspection = async (params: unknown, includeOriginal = true) => {
      const requestId = crypto.randomUUID();
      const execution = { v: 1 as const, authorization: setup, effectActionId: 'projects.inspect', target: setup.binding.target,
        installationId: machine.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
          authorizationToken: setup.token, effectActionId: 'projects.inspect', target: setup.binding.target,
          installationId: machine.installationId!, method: inspectMethod, requestId, params, privateKey: keys.secretKey }) };
      return verifyExternalActionMachineRpcExecution(execution, { method: inspectMethod, requestId, params,
        ...(includeOriginal ? { originalActionEnvelope: setupEnvelope } : {}) });
    };
    expect(await verifySetupInspection(inspectRepository)).not.toBeNull();
    expect(await verifySetupInspection({ ...inspectRepository,
      workspace: { ...setupInput.workspace, rootPath: '/tmp/another-project' } })).toBeNull();
    expect(await verifySetupInspection({ ...inspectRepository, reviewSharedSetup: { sourceId: 'selected-source' } })).toBeNull();
    expect(await verifySetupInspection(inspectRepository, false)).toBeNull();
    const { managed, root } = await createBoundManagedMachine(fixture);
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

it('requires the bound Machine signer for the managed delete census on its Home', async () => {
  const fixture = await createFixture();
  const { account, app, homeId, keys, machine, mint, verify } = fixture;
  try {
    const { managed } = await createBoundManagedMachine(fixture);
    const deleteInput = { homeId, managedId: managed.id, expectedRevision: 0, when: 'now', intent: 'delete', reviewedDependencies: true };
    const deleteRoot = await mint('machines.managed.delete', deleteInput);
    if (typeof deleteRoot === 'string') throw new Error(`Managed delete did not mint: ${deleteRoot}`);
    const deleteCensus = `/v1/deployments/machine-references?homeId=${encodeURIComponent(homeId)}&machineId=${encodeURIComponent(machine.id)}`;
    expect(await verify(deleteRoot, 'machines.managed.delete', 'GET', deleteCensus, undefined))
      .toEqual({ admitted: true, phase: undefined });
    expect((await verify(deleteRoot, 'machines.managed.delete', 'GET',
      `/v1/deployments/machine-references?homeId=another-home&machineId=${encodeURIComponent(machine.id)}`, undefined)).admitted)
      .toBe(false);
    const sourceKeys = tweetnacl.sign.keyPair();
    const source = await db.machine.create({ data: {
      id: crypto.randomUUID(), accountId: account.id, metadata: machine.metadata,
      dataEncryptionKey: machine.dataEncryptionKey, installationId: crypto.randomUUID(),
      installationPublicKey: new Uint8Array(sourceKeys.publicKey),
    } });
    const sourceSession = await db.session.create({ data: {
      accountId: account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain',
    } });
    await db.accessKey.create({ data: {
      accountId: account.id, machineId: source.id, sessionId: sourceSession.id, data: 'source-session-key',
    } });
    const binding = deleteRoot.binding;
    if (!('authentication' in binding)) throw new Error('Expected an Account delete admission');
    const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, requestId: binding.requestId,
      caller: { kind: 'session', sessionId: sourceSession.id, starterDepth: 1, turnDepth: 1 },
      sourceTurnId: 'delete-turn', callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    });
    // Keep mint and signer verification real. Only current socket publisher discovery is supplied by the fixture.
    const resolveCurrentSessionMachine = async () => source.id;
    const sessionDelete = await auth.mintExternalActionExecutionAuthorization({ ...binding, sessionActionOrigin,
      sessionActionSource: { machineId: source.id, installationId: source.installationId! },
    }, { resolveCurrentSessionMachine });
    expect(await verify(sessionDelete, 'machines.managed.delete', 'GET', deleteCensus, undefined,
      { privateKey: keys.secretKey, resolveCurrentSessionMachine })).toEqual({ admitted: true, phase: undefined });
    expect(await verify(sessionDelete, 'machines.managed.delete', 'GET', deleteCensus, undefined,
      { privateKey: sourceKeys.secretKey, resolveCurrentSessionMachine }))
      .toEqual({ admitted: false, phase: 'managed_machine_purpose' });
  } finally {
    await app.close();
  }
});
