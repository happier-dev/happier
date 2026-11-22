import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor, SessionSpawnNewActionResultV1Schema, SessionSpawnNewInputV2Schema,
  projectSessionSpawnNewActionInputV2, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { replayLiveCliApprovalOrigin } from '@/session/actions/approvals/replayLiveOrigin';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { enqueuePendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { fixture as createNativeFixture, roleResult } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './managedMachinePolicyRuntime';
import { executeManagedMachinePolicyAction } from './managedMachinePolicyAction';
import { db } from '../../../../server/sources/storage/db';

let captures: string;
let guest: Awaited<ReturnType<typeof startInstalledDaemonFixture>>;
let stopDaemon: (() => Promise<void>) | undefined;
beforeAll(async () => {
  captures = await mkdtemp(join(tmpdir(), 'managed-accepted-input-'));
  // The real SystemTool owner rejects runtime names. This executable stands in
  // for the external native Agent, as in the installed Session host fixture.
  const nativeAgent = join(captures, process.platform === 'win32' ? 'accepted-input-agent.exe' : 'accepted-input-agent');
  await cp(process.execPath, nativeAgent);
  const program = `const { appendFileSync } = require('node:fs');
    appendFileSync(${JSON.stringify(join(captures, 'inputs.jsonl'))}, JSON.stringify({ open: JSON.parse(process.argv[1]),
      inputIds: JSON.parse(process.argv[2]), input: process.argv[3] }) + '\\n');
    process.stdout.write('Accepted input completed.');`;
  guest = await startInstalledDaemonFixture({ registerCleanup: cleanup => { stopDaemon = cleanup; },
    plugins: [createFirstConversationAgentFixture('ORIGINAL_INPUT', {
      fixedDefaultPermission: true,
      nativeSession: { providerSessionId: 'retained-accepted-input' },
      nativeReply: { executableNames: [nativeAgent], args: ['-e', program, '--'] },
    })] });
}, 120_000);
afterAll(async () => {
  try { await stopDaemon?.(); }
  finally { if (captures) await rm(captures, { recursive: true, force: true }); }
}, 120_000);

it('recovers the original accepted Pending input at controller startup, approves shared Ask, starts the retained guest and delivers once', async () => {
  const nativeInputPath = join(captures, 'inputs.jsonl');
  const nativeComputePath = join(captures, 'compute.jsonl');
  const owner = guest.createActionExecutor();
  const context = { surface: 'ui' as const, externalActionTarget: { kind: 'machine' as const, machineId: guest.machineId,
    project: { machineId: guest.machineId, directory: guest.directory } } };
  const born = await owner.execute('session.spawn_new', projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
    creationKey: randomUUID(), executionTarget: { serverId: guest.serverId, machineId: guest.machineId },
    directory: { kind: 'path', path: guest.directory }, organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, initialInput: { text: 'ORIGINAL_INPUT_FIRST' },
  })), context);
  expect(born, JSON.stringify(born)).toMatchObject({ ok: true });
  if (!born.ok) throw new Error('Retained Session birth refused');
  const birth = SessionSpawnNewActionResultV1Schema.parse(born.result);
  if (birth.type !== 'success') throw new Error(`Retained Session did not start: ${JSON.stringify(birth)}`);
  const sessionId = birth.sessionId;
  await vi.waitFor(async () => {
    expect((await guest.home.readWorkflowSessionEffects()).turns.filter(turn => turn.sessionId === sessionId))
      .toMatchObject([{ status: 'completed' }]);
    expect(await readFile(nativeInputPath, 'utf8')).toContain('ORIGINAL_INPUT_FIRST');
  }, { timeout: 30_000 });
  expect(await owner.execute('session.wait.idle', { sessionId }, context)).toMatchObject({ ok: true });
  // Retire the runner as the guest goes away. A person's Stop would hold automatic resume.
  const retired = await owner.execute('session.stop', { sessionId, stopIntent: 'lifecycle_control' }, context);
  expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, result: { stopped: true } });
  await vi.waitFor(async () => expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ active: false }));

  // These are the genuine compute provider handlers. Home policy, signing,
  // approval, native invocation and guest reconnect remain production code.
  const nativeDeclaration = createNativeFixture({ privateNative: true, supportedIntents: ['start'] }).manifest;
  const results = Object.fromEntries(nativeDeclaration.contributes.actions.map(action => [action.id, roleResult(action.id)]));
  const compute = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: guest.homeDirectory, plugins: [{
    manifest: nativeDeclaration,
    files: { 'daemon.mjs': `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
      const path = ${JSON.stringify(nativeComputePath)};
      const results = ${JSON.stringify(results)};
      export function activate(api) { for (const [id, result] of Object.entries(results)) api.actions.register(id, async input => {
        appendFileSync(path, JSON.stringify({ role: id, intent: input?.intent }) + '\\n');
        if (id === 'inspect') return { availability: 'present', storage: 'retained',
          power: existsSync(path) && readFileSync(path, 'utf8').includes('"role":"power"') ? 'running' : 'stopped', observedAt: Date.now() };
        return result;
      }); }` },
  }] });
  onTestFinished(() => compute.dispose());
  const keys = tweetnacl.sign.keyPair();
  const controller = await db.machine.create({ data: { id: randomUUID(), accountId: guest.home.accountId,
    installationId: randomUUID(), installationPublicKey: keys.publicKey, active: true,
    metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
      homeDir: '/controller', happyHomeDir: '/controller/.happier' }) } });
  const launch = { provider: { pluginId: nativeDeclaration.id, localId: 'vm' }, schemaVersion: 1, name: 'Retained guest', choices: {} };
  const provisioner = nativeDeclaration.contributes.machineProvisioners[0]!;
  const reviewedFacts = ManagedConfigurationFactsV1Schema.parse({ launch, provisioner,
    controller: { machineId: controller.id, installationId: controller.installationId! }, optionStatus: 'current',
    billing: provisioner.billing, prerequisites: [], retentionCapabilities: provisioner.retention,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
  const managed = await db.managedMachine.create({ data: { homeId: guest.home.homeId,
    custodianAccountId: guest.home.accountId, controllerMachineId: controller.id,
    controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(), admittedInput: {},
    enrolledMachineId: guest.machineId, allocation: 'bound', creationState: 'active', desired: 'stop', intentRevision: 1,
    launch, reviewedFacts,
    resource: { contributionRef: { pluginId: nativeDeclaration.id, localId: 'vm' }, schemaVersion: 1, value: {} },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
    observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: Date.now() },
  } });
  const pendingOwner = createActionExecutor(createCliActionDeps({ credentials: guest.ownerCredentials,
    token: guest.ownerCredentials.token, sessionId, mode: 'plain', ctx: null, serverId: guest.serverId,
    serverIdentityId: guest.home.homeId, serverHttpBaseUrl: guest.home.baseUrl,
    actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } }));
  const localId = randomUUID();
  const resumeGuestNetwork = await guest.home.pauseInstalledMachineNetwork();
  onTestFinished(resumeGuestNetwork);
  await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: guest.machineId } })).toMatchObject({ active: false }));
  // Native Send retains Pending while the guest is stopped. CLI Send has a
  // separate Machine admission contract and cannot stand in for this surface.
  expect(await runWithServerHttpBaseUrl(guest.home.baseUrl, () => enqueuePendingQueueV2MessageViaHttp({
    token: guest.ownerCredentials.token, sessionId, body: { localId, messageRole: 'user',
      requestedAction: { v: 1, kind: 'enqueue' }, content: { t: 'plain', v: {
        role: 'user', content: { type: 'text', text: 'ORIGINAL_INPUT_QUEUED' }, meta: { source: 'ui' },
      } } },
  }))).toMatchObject({ didWrite: true, terminal: false });
  const armed = await runWithServerHttpBaseUrl(guest.home.baseUrl, () => pendingOwner.execute('session.pending.action.set', {
    sessionId, localId, requestedAction: { v: 1, kind: 'enqueue' }, resumeWhenAvailable: true,
  }, { surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'session.pending.action.set' } }));
  expect(armed, JSON.stringify(armed)).toMatchObject({ ok: true });
  const censusInput = { homeId: guest.home.homeId, controller: { machineId: controller.id, installationId: controller.installationId! },
    custodianAccountId: guest.home.accountId, privateKey: keys.secretKey, token: guest.installedCredentials.token, serverUrl: guest.home.baseUrl };
  const census = await readManagedMachinePolicyCensus(censusInput);
  expect(census.targets).toMatchObject([{ managedId: managed.id,
    origin: { kind: 'session-input', session: { sessionId }, pendingRequestId: localId } }]);

  const unavailable = async (): Promise<never> => { throw new Error('Fixture has no connected account'); };
  const authority = createManagedProviderOperationAuthority({ purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
    selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
    projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
  }) });
  const policyOperationId = randomUUID();
  const operations = createHostActionOperationRuntime({ machineId: controller.id, resolveAccountId: async () => guest.home.accountId,
    generateOperationId: () => policyOperationId });
  const currentOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: guest.home.baseUrl, resolveCurrentMachineId: () => controller.id });
  const currentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials: guest.installedCredentials,
    machineId: controller.id, serverId: guest.serverId, serverApiUrl: guest.home.baseUrl,
    resolveCurrentMachineExecutionOriginContext: currentOrigin });
  const executorParams = { credentials: guest.installedCredentials, token: guest.installedCredentials.token,
    sessionId: 'managed-policy', serverId: guest.serverId, serverIdentityId: guest.home.homeId, serverHttpBaseUrl: guest.home.baseUrl,
    mode: 'plain' as const, ctx: null, pluginActionExecutionOwner: 'current_process' as const,
    isApprovalExecutionOriginCurrent: currentness, runActionOperation: operations.runActionOperation };
  const adapter = createDaemonManagedMachineActionAdapter({ credentials: guest.installedCredentials, machineId: controller.id,
    serverBaseUrl: guest.home.baseUrl, serverId: guest.serverId,
    installationIdentity: { installationId: controller.installationId!, privateKey: keys.secretKey },
    managedProviderOperationAuthority: authority, resolveCurrentMachineExecutionOriginContext: currentOrigin,
    acquireRuntimeRegistryLease: () => compute.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => compute.registry }),
    observeActionExecution: request => operations.observeExecution(request),
    executeManagedPolicyAction: (machine, policyContext, runApproved, purpose) => executeManagedMachinePolicyAction({
      machine, context: policyContext, runApproved, purpose, serverId: guest.serverId,
      createExecutor: overrides => createCliActionExecutorFromCredentials({ ...executorParams, serverApiUrl: guest.home.baseUrl,
        machineId: controller.id, readCredentials: async () => guest.installedCredentials, ...overrides }),
    }),
  });
  const scheduler = createDaemonManagedMachinePolicyRuntime({
    readCensus: signal => readManagedMachinePolicyCensus({ ...censusInput, signal }),
    executePolicy: adapter.executePolicy, reconcileObservation: adapter.reconcileObservation,
  });
  onTestFinished(() => scheduler.stop());
  scheduler.notifyChanged();
  const deciding = createActionExecutor({ ...createCliActionDeps({ ...executorParams,
    credentials: guest.ownerCredentials, token: guest.ownerCredentials.token }),
    approvalRequestApprovedReplay: request => replayLiveCliApprovalOrigin(request, {
      token: guest.ownerCredentials.token, serverUrl: guest.home.baseUrl,
    }),
  });
  let artifactId = '';
  await vi.waitFor(async () => {
    const artifacts = await db.artifact.findMany({ where: { accountId: guest.home.accountId } });
    const open = artifacts.find(artifact => getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifact.id) === 1);
    expect(open).toBeDefined();
    artifactId = open!.id;
  }, { timeout: 20_000 });
  const decisionContext = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
    runtimeAccountId: guest.home.accountId, serverId: guest.serverId, serverIdentityId: guest.home.homeId,
    actionRequestId: randomUUID() };
  const approval = await deciding.execute('approval.request.get', { artifactId }, decisionContext);
  expect(approval, JSON.stringify(approval)).toMatchObject({ ok: true, result: { request: {
    status: 'open', actionId: 'machines.managed.power.set',
    actionArgs: { homeId: guest.home.homeId, managedId: managed.id, intent: 'start', when: 'now', expectedRevision: 1 },
    executionOriginV1: { accountId: guest.home.accountId, machineId: controller.id }, approval: { flow: 'blocking' },
  } } });
  expect((await readFile(nativeComputePath, 'utf8')).includes('"role":"power"')).toBe(false);
  const approved = await deciding.execute('approval.request.decide', { artifactId, decision: 'approve' }, decisionContext);
  expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true });
  await vi.waitFor(async () => expect(await readFile(nativeComputePath, 'utf8')).toContain('"role":"power","intent":"start"'), { timeout: 20_000 });
  expect(await operations.handlers.getV2({ operationId: policyOperationId, waitForTerminal: true }))
    .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
  expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } })).toMatchObject({
    desired: 'start', intentRevision: 2, observation: { availability: 'present', power: 'running', storage: 'retained' },
  });
  await resumeGuestNetwork();
  await vi.waitFor(async () => {
    const rows = (await readFile(nativeInputPath, 'utf8')).trim().split('\n').map(line => {
      const { open, inputIds, input } = JSON.parse(line) as {
        open: { kind: string; providerSessionId: string }; inputIds: string[]; input: string;
      };
      // Host system context may precede these single-line user messages.
      return { open, inputIds, input: input.split('\n').at(-1) };
    });
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      { open: { kind: 'create', providerSessionId: 'retained-accepted-input' }, input: 'ORIGINAL_INPUT_FIRST' },
      { open: { kind: 'resume', providerSessionId: 'retained-accepted-input' }, input: 'ORIGINAL_INPUT_QUEUED', inputIds: [localId] },
    ]);
  }, { timeout: 30_000 });
  expect(await owner.execute('session.wait.idle', { sessionId }, context)).toMatchObject({ ok: true });
  const effects = await guest.home.readWorkflowSessionEffects();
  expect(effects.pending).toEqual([]);
  expect(effects.messages.filter(message => message.sessionId === sessionId && message.localId === localId && message.messageRole === 'user'))
    .toHaveLength(1);
  expect(effects.turns.filter(turn => turn.sessionId === sessionId)).toEqual([
    expect.objectContaining({ status: 'completed' }), expect.objectContaining({ status: 'completed' }),
  ]);
  const nativeEffects = (await readFile(nativeComputePath, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { role: string; intent?: string });
  expect(nativeEffects.filter(effect => effect.role === 'power')).toEqual([{ role: 'power', intent: 'start' }]);
}, 120_000);
