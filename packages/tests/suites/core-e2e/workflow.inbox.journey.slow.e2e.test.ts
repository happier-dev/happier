import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import axios from 'axios';
import { createCredentialedAccountArtifactStore } from '../../../../apps/cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { seedCurrentLocalPathPluginFixture } from '../../../../apps/cli/src/plugins/store/registry/currentState.testkit';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
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
