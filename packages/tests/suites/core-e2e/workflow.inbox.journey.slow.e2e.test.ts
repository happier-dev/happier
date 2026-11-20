import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import axios from 'axios';
import { DeploymentActionOutputSchemasV1, MachineServicesListResultV1Schema } from '@happier-dev/protocol';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createCredentialedAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { seedCurrentLocalPathPluginFixture } from '../../../../apps/cli/src/plugins/store/registry/currentState.testkit';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema, projectExternalActionExecutionResultV1, type ActionExecuteResult } from '@happier-dev/protocol/actions';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowInvocationListResultV1Schema,
  WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { connectUiPersonActionClient, mountUiInboxJourney } from '@happier-tests/ui-action-client';
import { startFinJourneyFixture } from '../../src/testkit/finJourney';
import { waitFor } from '../../src/testkit/timing';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'fin-inbox' });
let fixture: Awaited<ReturnType<typeof startFinJourneyFixture>> | undefined;
beforeAll(async () => {
  fixture = await startFinJourneyFixture({ testDir: run.testDir('inbox'),
    serverEnv: { ...process.env, HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
});
afterAll(async () => { await fixture?.stop(); });

it('J7 Notify me removes a failed sender from real option discovery after attempted delivery', async () => {
  if (!fixture) throw new Error('Inbox journey Home did not start');
  const actor = await fixture.createAccount('failed-sender-owner');
  const pluginId = 'acme.fin-failed-sender';
  const channelId = `${pluginId}/external`;
  const pluginRoot = run.testDir('failed-sender-plugin');
  const marker = join(pluginRoot, 'activation-count');
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Failed sender journey',
    engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
    hostAccess: { required: [], optional: [] }, contributes: { notificationChannels: [{
      id: 'external', kind: 'plugin', title: 'External fixture', configurable: true, defaultEnabled: true,
    }] },
  }));
  await writeFile(join(pluginRoot, 'daemon.mjs'), `import { appendFile } from 'node:fs/promises';
    export async function activate() {
      await appendFile(${JSON.stringify(marker)}, 'activated\\n');
      throw new Error('fixture activation failed');
    }`);
  const machine = await fixture.enrollDaemon(actor, { prepareHome: async homeDir => {
    await seedCurrentLocalPathPluginFixture({ happyHomeDir: homeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
  } });
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl, accountSecret: actor.auth.accountSigningSeed });
  const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: ui.serverId,
    serverIdentityId: fixture.serverId, externalActionTarget: { kind: 'machine' as const, machineId: machine.target.machineId } };
  try {
    await waitFor(() => ui.isMachineActive(machine.target.machineId), { context: 'UI observes the sender daemon' });
    const options = async () => {
      const result = await ui.execute('action.options.resolve', {
        actionId: 'notifications.notify_me', fieldPath: 'channels', draftInput: {},
      }, context);
      if (!result.ok) throw new Error(result.errorCode);
      return result.result;
    };
    const available = await options();
    expect(available).toMatchObject({ options: expect.arrayContaining([expect.objectContaining({ value: channelId })]) });
    expect(available).toMatchObject({ options: expect.not.arrayContaining([expect.objectContaining({ value: channelId, disabled: true })]) });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const delivered = await ui.executeConfirmed('notifications.notify_me',
      { message: 'Exercise the failed external sender', channels: [channelId] }, context);
    expect(delivered).toMatchObject({ ok: false, errorCode: 'notification_delivery_unavailable',
      details: { attemptedChannels: 1, deliveredChannels: 0 } });
    expect(await readFile(marker, 'utf8')).toBe('activated\n');
    expect(await options()).toMatchObject({ options: expect.not.arrayContaining([expect.objectContaining({ value: channelId })]) });
  } finally { await ui.close(); }
});

it('J7 a stopped native service produces a mounted Inbox notice with working Restart and Dismiss', async () => {
  if (!fixture) throw new Error('Inbox journey Home did not start');
  const actor = await fixture.createAccount('native-notice-owner');
  await fixture.claimHomeOwner(actor);
  const toolsDir = run.testDir('native-service-tools');
  // Docker is the external process boundary. Deployment admission, retained
  // service identity, health observation, notices and recovery Actions are real.
  const docker = await createOwnServerDockerBoundary(toolsDir);
  const machine = await fixture.enrollDaemon(actor, { env: { ...process.env,
    PATH: `${toolsDir}${delimiter}${process.env.PATH ?? ''}` } });
  const call = (actionId: ActionId, input: unknown) => actor.execute(actionId, input, {
    presentUserConfirmation: { actionId }, externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
  });
  const settle = async (result: ActionExecuteResult) => {
    if (!result.ok) throw new Error(result.errorCode);
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (!approval.success) return result.result;
    const decision = await call('approval.request.decide', { artifactId: approval.data.artifactId, decision: 'approve' });
    if (!decision.ok) throw new Error(decision.errorCode);
    const settlement = decision.result;
    const execution = settlement && typeof settlement === 'object' && 'execution' in settlement
      ? projectExternalActionExecutionResultV1(settlement.execution) : null;
    if (!execution) throw new Error('Native service approval did not return a settled execution');
    if (!execution.ok) throw new Error(execution.errorCode);
    return execution.result;
  };
  const invoke = async (actionId: ActionId, input: unknown) => settle(await call(actionId, input));
  const source = ProjectSourcesReadOutputV1Schema.parse(await invoke('projects.sources.create', {
    serverId: fixture.serverId, name: 'Native Inbox service', requestKey: randomUUID(),
  }));
  if (!source.ok) throw new Error(source.error);
  const image = await docker.registerImage('app', 'inbox-native-service');
  const document = JSON.stringify({ services: { app: { image: image.registryReference } } });
  const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Native Inbox service', retainPreviousDeployments: 1,
    definition: { kind: 'stored', document, contentRevision: 1,
      composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] },
    bindings: [], ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } });
  const store = runWithServerHttpBaseUrl(fixture.server.baseUrl, () => createCredentialedAccountArtifactStore(actor.credentials));
  const artifact = async (kind: typeof DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 | typeof DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, body: string) => {
    const created = await runWithServerHttpBaseUrl(fixture!.server.baseUrl,
      () => store.create({ header: { kind, title: content.name }, body }));
    return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
      contentBodyVersion: created.revision.bodyVersion };
  };
  const environment = DeploymentActionOutputSchemasV1['deployments.environments.create'].parse(await invoke('deployments.environments.create', {
    serverId: fixture.serverId, projectSourceId: source.source.id, requestKey: randomUUID(),
    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
    controllerMachineId: machine.target.machineId, buildMachineId: machine.target.machineId,
    ...await artifact(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, JSON.stringify(content)),
  }));
  if (!('ok' in environment) || !environment.ok) throw new Error('Environment creation did not persist');
  const identity = MachineInstallationIdentityV1Schema.parse(JSON.parse(await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
  const target = DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(await invoke('deployments.targets.link', {
    serverId: fixture.serverId, environmentId: environment.environmentId, expectedRevision: environment.revision,
    requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
    machines: [{ machineId: machine.target.machineId, installationId: identity.installationId }],
    ...await artifact(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, '{}'),
  }));
  if (!target.ok) throw new Error(target.error);
  const deployed = DeploymentActionOutputSchemasV1['deployments.deploy'].parse(await invoke('deployments.deploy', {
    serverId: fixture.serverId, environmentId: environment.environmentId, targetLinkId: target.targetLinkId,
  }));
  expect(deployed.ok).toBe(true);
  const services = async () => {
    const value = MachineServicesListResultV1Schema.parse(await invoke('machines.services.list', {
      serverId: fixture!.serverId, machineId: machine.target.machineId, environmentId: environment.environmentId,
    }));
    if (value.kind !== 'snapshot') throw new Error(`Native service inventory unavailable: ${value.reason}`);
    return value.services;
  };
  await waitFor(async () => (await services()).some(service => service.native?.phase === 'running'),
    { context: 'Real deployment reaches a running native service' });
  const running = (await services()).find(service => service.native?.phase === 'running');
  expect(running?.generation).toBeTruthy();
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl, accountSecret: actor.auth.accountSigningSeed });
  let inbox: Awaited<ReturnType<typeof mountUiInboxJourney>> | undefined;
  try {
    inbox = await mountUiInboxJourney();
    const notice = () => inbox?.getCurrent()?.openAccountNotices.find(entry => entry.header.source.kind === 'host'
      && entry.header.source.topic === 'service_health' && entry.header.source.subject.kind === 'deployment'
      && entry.header.source.subject.environmentId === environment.environmentId);
    await docker.stopCurrentContainers();
    await waitFor(async () => (await services()).some(service => service.serviceId === running!.serviceId && service.native?.phase === 'stopped'),
      { context: 'Native stop is observed by the canonical service owner' });
    await waitFor(() => notice() !== undefined, { context: 'Service failure arrives in mounted Inbox through real sync' });
    const entry = notice()!;
    const model = inbox.getCurrent()!;
    const choice = model.noticeInvestigation.readRecoveryChoices(entry).findIndex(item => item.actionId === 'deployments.restart');
    expect(choice).toBeGreaterThanOrEqual(0);
    const restarted = await model.noticeInvestigation.runRecoveryChoice(entry, choice, {
      externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
    });
    await settle(restarted);
    await waitFor(async () => (await services()).some(service => service.serviceId === running!.serviceId
      && service.generation === running!.generation && service.native?.phase === 'running'),
    { context: 'Inbox Restart restores the same native generation' });
    // Produce another real failure so Dismiss always acts on an open notice.
    await docker.stopCurrentContainers();
    await waitFor(async () => (await services()).some(service => service.serviceId === running!.serviceId && service.native?.phase === 'stopped'),
      { context: 'Second native stop is observed' });
    await waitFor(() => notice() !== undefined, { context: 'Open service notice is available to dismiss' });
    const dismissed = notice()!;
    await inbox.getCurrent()!.dismissAccountNotice(dismissed);
    await waitFor(() => inbox?.getCurrent()?.openAccountNotices.some(item => item.artifact.id === dismissed.artifact.id) === false,
      { context: 'Dismiss removes the exact service notice from the mounted Inbox' });
    const persisted = ArtifactActionOutputSchemasV1['artifact.get'].parse(await invoke('artifact.get', { artifactId: dismissed.artifact.id }));
    expect(persisted.artifact?.header).toMatchObject({ status: 'dismissed' });
  } finally { try { await inbox?.unmount(); } finally { await ui.close(); } }
});

it('J7 headless inbox.get reads the persisted notice index once and opens selected bodies in one batch', async () => {
  if (!fixture) throw new Error('Inbox journey Home did not start');
  const actor = await fixture.createAccount('notice-index-owner');
  const accountId = readAccountIdFromToken(actor.credentials.token);
  if (!accountId) throw new Error('Fixture Account identity is unavailable');
  const serverUrl = fixture.server.baseUrl;
  const store = runWithServerHttpBaseUrl(serverUrl, () => createCredentialedAccountArtifactStore(actor.credentials));
  const noticeIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const notice = await runWithServerHttpBaseUrl(serverUrl, () => store.writeNotice({ accountId,
      source: { kind: 'plugin', pluginId: 'acme.fin-notices', itemId: `notice-${index}` },
      type: 'update', resolved: false, title: `Notice ${index}`, body: `Notice ${index}` }));
    noticeIds.push(notice.artifactId);
    const created = await actor.execute('artifact.create', {
      header: { kind: 'markdown', title: `Unrelated Doc ${index}` }, body: 'Unrelated content',
    }, { presentUserConfirmation: { actionId: 'artifact.create' } });
    if (!created.ok) throw new Error(created.errorCode);
  }
  const requests: URL[] = [];
  // Observe real HTTP without replacing storage, codecs, selection or responses.
  const observation = axios.interceptors.request.use(config => {
    const url = new URL(axios.getUri(config));
    if (url.origin === fixture!.server.baseUrl && url.pathname.startsWith('/v1/artifacts')) requests.push(url);
    return config;
  });
  try {
    const read = await actor.execute('inbox.get', {});
    if (!read.ok) throw new Error(read.errorCode);
    expect(read.result).toMatchObject({ accountNoticeIds: expect.arrayContaining(noticeIds), refreshFailed: false });
    const lists = requests.filter(url => url.pathname === '/v1/artifacts');
    expect(lists).toHaveLength(1);
    expect(JSON.parse(lists[0]!.searchParams.get('kinds') ?? 'null')).toContain(ACCOUNT_NOTICE_ARTIFACT_KIND_V1);
    expect(requests.filter(url => url.pathname === '/v1/artifacts/read')).toHaveLength(1);
    expect(requests.filter(url => url.pathname !== '/v1/artifacts' && url.pathname !== '/v1/artifacts/read')).toEqual([]);
  } finally { axios.interceptors.request.eject(observation); }
});

it('J7 a held Run reaches the mounted Inbox and completing its review removes Needs you', async () => {
  if (!fixture) throw new Error('Inbox journey Home did not start');
  const actor = await fixture.createAccount('inbox-owner');
  const machine = await fixture.enrollDaemon(actor, { env: { ...process.env,
    HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl, accountSecret: actor.auth.accountSigningSeed });
  let inbox: Awaited<ReturnType<typeof mountUiInboxJourney>> | undefined;
  const act = async (actionId: ActionId, input: unknown) => {
    const result = await ui.executeConfirmed(actionId, input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: ui.serverId, serverIdentityId: fixture!.serverId,
      actionRequestId: randomUUID(), externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
    expect(result.ok, `${actionId}: ${result.ok ? 'ok' : result.errorCode}`).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    return result.result;
  };
  const readInbox = async () => {
    const result = await ui.execute('inbox.get', {}, { surface: 'ui', authority: 'present_user', serverId: ui.serverId });
    if (!result.ok) throw new Error(result.errorCode);
    return AppShellActionOutputSchemas['inbox.get'].parse(result.result);
  };
  try {
    inbox = await mountUiInboxJourney();
    const saved = WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.create', {
      definitionId: randomUUID(), metadata: { title: 'Inbox review journey' },
      definition: { version: 1, blocks: [
        { kind: 'wait', id: 'review', document: { text: 'Review before continuing', references: [], attachments: [] } },
        { kind: 'action', id: 'finish', actionId: 'machines.command.run',
          input: { command: { kind: 'literal', value: 'echo inbox-reviewed' } } },
      ] },
    }));
    const started = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
      runId: randomUUID(), source: { kind: 'saved', definitionId: saved.definitionId, revision: saved.revision },
      executionTarget: { kind: 'session' },
    }));
    const runId = started.run.id;
    await act('workflow.run.wait', { runId, conditions: ['attention'] });
    await waitFor(() => inbox?.getCurrent()?.items.some(item =>
      item.focus.kind === 'workflow_run' && item.focus.id === runId && item.view === 'needs_you') === true,
    { context: 'Held Workflow reaches the mounted canonical Inbox through real sync' });
    const held = await readInbox();
    expect(held.status).toMatch(/^(ready|partial)$/);
    if (held.status !== 'ready' && held.status !== 'partial') throw new Error('Mounted Inbox read did not settle');
    expect(held.items).toEqual(expect.arrayContaining([expect.objectContaining({
      view: 'needs_you', focus: expect.objectContaining({ kind: 'workflow_run', id: runId }),
    })]));
    const history = WorkflowInvocationListResultV1Schema.parse(await act('workflow.run.invocations.list', { runId, includeContent: true }));
    const gate = history.invocationDetails?.find(item => item.index.lifecycle === 'waiting_for_review');
    expect(gate, 'The held Run must expose its authoritative review invocation').toBeDefined();
    if (!gate) throw new Error('Workflow review invocation unavailable');
    await act('workflow.run.invocations.complete_review', { runId, invocation: { recordId: gate.index.id },
      expectedContentRevision: gate.index.contentRevision, mode: 'use_result' });
    await waitFor(() => inbox?.getCurrent()?.items.some(item =>
      item.focus.kind === 'workflow_run' && item.focus.id === runId && item.view === 'needs_you') === false,
    { context: 'Completing review withdraws the real Inbox Needs-you hold' });
    const after = await readInbox();
    expect(after.status).toMatch(/^(ready|partial)$/);
    if (after.status !== 'ready' && after.status !== 'partial') throw new Error('Mounted Inbox read did not settle');
    expect(after.items.some(item => item.focus.kind === 'workflow_run' && item.focus.id === runId && item.view === 'needs_you')).toBe(false);
  } finally { try { await inbox?.unmount(); } finally { await ui.close(); } }
});
