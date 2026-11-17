import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { create as createTar } from 'tar';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupApplyResultV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupOperationV1';
import { WorkflowRunGetResultV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ApprovalQueueListResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { MachinesAgentsListOutputSchema } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';

import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const testDir = run.testDir(`team-setup-agents-${randomUUID()}`);
let fixture: TeamSetupFFixture | undefined;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let machineId: string;
let credentials: Parameters<typeof connectUiActionClient>[0]['credentials'];
let github: Server | undefined;
let downloads = 0;
let releaseChecks = 0;
let denyRelease = false;
let account: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
let workspaceDir: string;
let nativeLog: string;
let nativeScript: string;

async function githubFixture(): Promise<string | undefined> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return undefined;
  const managed = getAgentCliRuntimeSpec('codex')?.managedInstall;
  if (managed?.kind !== 'github_release_binary' || !managed.releaseTag) throw new Error('Expected bundled pinned Codex');
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error('Unsupported fixture architecture');
  const assetName = managed.assetNameByPlatform?.[process.platform][process.arch];
  const entries = managed.archiveEntriesByPlatform?.[process.platform];
  if (!assetName || !entries) throw new Error('Expected bundled Codex package layout');
  const packageDir = join(testDir, 'github-package');
  for (const entry of entries) {
    const path = join(packageDir, entry.archivePath);
    await mkdir(dirname(path), { recursive: true });
    // Only the external provider's downloaded executables are fixtures. The
    // checksum, extraction, execution, inventory and Happier owners stay real.
    await writeFile(path, '#!/bin/sh\nprintf "codex 0.162.1\\n"\n', { mode: 0o755 });
  }
  const archive = join(testDir, assetName);
  await createTar({ cwd: packageDir, file: archive, gzip: true }, entries.map(entry => entry.archivePath));
  const binary = await readFile(archive);
  const downloadPath = `/${managed.githubRepo}/releases/download/${managed.releaseTag}/${assetName}`;
  const digest = createHash('sha256').update(binary).digest('hex');
  github = createServer((request, response) => {
    if (request.url === downloadPath) {
      downloads += 1;
      response.writeHead(200, { 'content-length': binary.length }); response.end(binary); return;
    }
    if (request.url?.startsWith(`/${managed.githubRepo}/releases/expanded_assets/`)) {
      releaseChecks += 1;
      if (denyRelease) {
        response.writeHead(403, { 'x-ratelimit-remaining': '0' }); response.end('Fixture GitHub rate limit'); return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<li><a href="${downloadPath}">${assetName}</a><clipboard-copy value="sha256:${digest}"></clipboard-copy></li>`);
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => github!.listen(0, '127.0.0.1', resolve));
  const address = github.address();
  if (!address || typeof address === 'string') throw new Error('Missing GitHub fixture address');
  const bootstrap = join(testDir, 'github-transport.mjs');
  await writeFile(bootstrap, `import https from 'node:https';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
const original = https.request.bind(https);
https.request = (url, options, callback) => {
  const target = typeof url === 'string' ? new URL(url) : url instanceof URL ? url : null;
  return target?.hostname === 'github.com' && target.pathname.startsWith('/openai/codex/releases/')
    ? http.request(new URL(target.pathname, ${JSON.stringify(`http://127.0.0.1:${address.port}`)}), options, callback)
    : original(url, options, callback);
};
syncBuiltinESMExports();
`);
  return pathToFileURL(bootstrap).href;
}

beforeAll(async () => {
  const features = { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' };
  fixture = await startTeamSetupFFixture({ testDir, serverEnv: { ...features,
    ...(process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL ? { DATABASE_URL: process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL } : {}) } });
  account = await fixture.createAccount('member');
  const githubBootstrap = await githubFixture();
  const enrolled = await fixture.enrollDaemon(account, { env: {
    ...features,
    NODE_OPTIONS: [fixture.sourceOptions, ...(githubBootstrap ? ['--import', githubBootstrap] : [])].join(' '),
    HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({ codex: 'managed-first' }),
  } });
  machineId = enrolled.target.machineId;
  workspaceDir = enrolled.workspaceDir;
  nativeLog = join(enrolled.workspaceDir, 'agent-native-setup.log');
  nativeScript = `printf 'setup-once\\n' >> ${safeBashSingleQuote(nativeLog)}`;
  credentials = account.uiCredentials;
});

// Each test connects after the shared UI device reset has run.
beforeEach(async () => {
  ui = await connectUiActionClient({ serverUrl: fixture!.server.baseUrl, credentials });
  try {
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
  } catch (cause) {
    throw new Error(`UI readiness failed: ${JSON.stringify({ accountReady: ui.isAccountReady(),
      machineActive: ui.isMachineActive(machineId) })}`, { cause });
  }
  const control = await action('machines.setup.plan', { homeId: ui.serverId, machineId, mode: 'effects',
    sources: [{ kind: 'direct', setup: { scripts: [{ body: 'printf "known-good setup plan\\n"' }] } }],
  });
  expect(control).toMatchObject({ ok: true, result: { recipePlans: [] } });
  if (!control.ok) throw new Error(control.errorCode);
  const controlPlan = MachineSetupPlanResultV1Schema.parse(control.result);
  const admittedControl = await action('machines.setup.apply', { homeId: ui.serverId, machineId, targets: [{
    homeId: ui.serverId, machineId, desiredRevision: controlPlan.desiredRevision, sources: controlPlan.sources,
    exclusions: controlPlan.exclusions, recipePlans: controlPlan.recipePlans ?? [], appChildren: controlPlan.appChildren,
  }] }, true);
  expect(admittedControl.ok).toBe(true);
  if (!admittedControl.ok) throw new Error(admittedControl.errorCode);
  const controlReceipt = MachineSetupApplyResultV1Schema.parse(admittedControl.result);
  await expect(action('action.operations.get', { serverId: ui.serverId, machineId, operationId: controlReceipt.operationId, waitForTerminal: true }))
    .resolves.toMatchObject({ ok: true, result: { kind: 'found', operation: { state: 'succeeded' } } });
});

afterEach(async () => { await ui?.close(); ui = undefined; });

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => ui?.close(), () => fixture?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (github) {
    github.closeAllConnections();
    await new Promise<void>(resolve => github!.close(() => resolve()));
  }
  if (failures.length) throw new AggregateError(failures, 'Agent setup fixture cleanup failed');
});

async function action(id: string, input: unknown, confirmed = false) {
  if (!ui) throw new Error('UI Action client not started');
  return (confirmed ? ui.executeConfirmed : ui.execute)(id as Parameters<typeof ui.execute>[0], input,
    { surface: 'ui', authority: 'present_user', serverId: ui.serverId, actionCaller: { kind: 'host' } });
}

it('TS.E.agents lowers declared agents to catalog children through the real Machine plan Action', async () => {
  const planned = await action('machines.setup.plan', {
    homeId: ui!.serverId, machineId, mode: 'effects',
    sources: [{ kind: 'direct', setup: { items: [{ kind: 'agent', agentId: 'team-setup/missing-agent' }] } }],
  });
  expect(planned).toMatchObject({ ok: true, result: {
    recipePlans: [],
    appChildren: [{ sourceIndex: 0, itemIndex: 0, actionId: 'machines.agents.install', input: {
      machineId, agentId: 'team-setup/missing-agent', intent: 'install', waitForTerminal: true, consent: { vendorRecipe: true },
    } }],
  } });
});

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('TS.E.agents retains native failure, retries only incomplete work and reconnects to catalog readiness', async () => {
  denyRelease = true;
  const failedPlan = await action('machines.setup.plan', { homeId: ui!.serverId, machineId, mode: 'effects',
    sources: [{ kind: 'direct', setup: { items: [{ kind: 'agent', agentId: 'codex' }], scripts: [{ body: nativeScript }] } }],
  });
  expect(failedPlan.ok).toBe(true);
  if (!failedPlan.ok) throw new Error(failedPlan.errorCode);
  const first = MachineSetupPlanResultV1Schema.parse(failedPlan.result);
  const failedApply = await action('machines.setup.apply', { homeId: ui!.serverId, machineId, targets: [{
    homeId: ui!.serverId, machineId, desiredRevision: first.desiredRevision, sources: first.sources,
    exclusions: first.exclusions, recipePlans: first.recipePlans ?? [], appChildren: first.appChildren,
  }] }, true);
  expect(failedApply.ok).toBe(true);
  if (!failedApply.ok) throw new Error(failedApply.errorCode);
  const failedReceipt = MachineSetupApplyResultV1Schema.parse(failedApply.result);
  await expect(action('action.operations.get', { serverId: ui!.serverId, machineId, operationId: failedReceipt.operationId, waitForTerminal: true }))
    .resolves.toMatchObject({ ok: true, result: { kind: 'found', operation: { state: 'failed',
      error: { errorCode: 'native_effect_failed', details: { outcome: { kind: 'failed', code: 'rate_limited' } } } } } });
  expect(downloads).toBe(0);
  expect(await readFile(nativeLog, 'utf8')).toBe('setup-once\n');
  denyRelease = false;
  const planned = await action('machines.setup.plan', { homeId: ui!.serverId, machineId, mode: 'effects',
    sources: [{ kind: 'direct', setup: { items: [{ kind: 'agent', agentId: 'codex' }, { kind: 'agent', agentId: 'codex' }],
      scripts: [{ body: nativeScript }] } }],
  });
  expect(planned.ok).toBe(true);
  if (!planned.ok) throw new Error(planned.errorCode);
  const plan = MachineSetupPlanResultV1Schema.parse(planned.result);
  expect(plan.appChildren).toHaveLength(1);
  expect(downloads).toBe(0);
  const applied = await action('machines.setup.apply', { homeId: ui!.serverId, machineId, targets: [{
    homeId: ui!.serverId, machineId, desiredRevision: plan.desiredRevision, sources: plan.sources,
    exclusions: plan.exclusions, recipePlans: plan.recipePlans ?? [], appChildren: plan.appChildren,
  }] }, true);
  expect(applied.ok).toBe(true);
  if (!applied.ok) throw new Error(applied.errorCode);
  const receipt = MachineSetupApplyResultV1Schema.parse(applied.result);
  await expect(action('action.operations.get', { serverId: ui!.serverId, machineId, operationId: receipt.operationId, waitForTerminal: true }))
    .resolves.toMatchObject({ ok: true, result: { kind: 'found', operation: { state: 'succeeded' } } });
  expect(downloads).toBe(1);
  expect(await readFile(nativeLog, 'utf8')).toBe('setup-once\n');
  await ui!.close();
  ui = await connectUiActionClient({ serverUrl: fixture!.server.baseUrl, credentials });
  await expect(action('machines.agents.list', { machineId, agentId: 'codex', refresh: true }))
    .resolves.toMatchObject({ ok: true, result: { items: [expect.objectContaining({ agentId: 'codex', installed: true,
      managed: true, version: '0.162.1' })] } });
  expect(downloads).toBe(1);
});

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('J6 requires person consent for an unreviewed Agent install and inherits the approved Session parent review', async () => {
  if (!fixture || !ui) throw new Error('Agent fixture unavailable');
  const inventory = await action('machines.agents.list', { machineId, agentId: 'codex', refresh: true });
  if (!inventory.ok) throw new Error(inventory.errorCode);
  if (MachinesAgentsListOutputSchema.parse(inventory.result).items.some(item => item.agentId === 'codex' && item.installed)) {
    const removed = await action('machines.agents.uninstall', { machineId, agentId: 'codex' }, true);
    if (!removed.ok) throw new Error(removed.errorCode);
    const job = DaemonAgentInstallStartResponseSchema.parse(removed.result);
    if (!job.ok) throw new Error('Could not remove the preceding test Agent installation');
    expect(await action('machines.agents.install.status', { machineId, jobId: job.jobId, cursor: 0, waitForTerminal: true }))
      .toMatchObject({ ok: true, result: { done: true, outcome: { kind: 'succeeded' } } });
  }
  for (const [actionId, mode] of [
    ['workflow.run.start', 'allowed'], ['session.spawn_new', 'allowed'], ['machines.agents.install', 'ask_first'],
  ] as const) {
    expect(await action('actions.policy.set', { actionId, audience: 'agent', mode }, true)).toMatchObject({ ok: true });
  }
  const start = async (approvalProfileId: string) => {
    const result = await account.execute('workflow.run.start', { runId: randomUUID(),
      source: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          approvalProfileId: 'builtin:full-trust', terminal: { mode: 'plain' } },
        blocks: [{ kind: 'step', id: 'agent-install', inputMode: 'none',
          document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
      } }, executionTarget: { kind: 'session' } }, {
      surface: 'agent', authority: 'account_automation', approvalProfileId,
      externalActionTarget: { kind: 'machine', machineId, project: { machineId, directory: workspaceDir } },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    return WorkflowRunStartResultV1Schema.parse(result.result).run;
  };
  const pendingApproval = async (actionId: string) => {
    let artifactId: string | undefined;
    await waitFor(async () => {
      const listed = await account.execute('approval.request.list', { status: 'open', actionId });
      if (!listed.ok) throw new Error(listed.errorCode);
      artifactId = ApprovalQueueListResultV1Schema.parse(listed.result).items[0]?.artifactId;
      return artifactId !== undefined;
    }, { timeoutMs: 60_000, context: `Workflow ${actionId} consent publication` });
    if (!artifactId) throw new Error('Workflow consent is unavailable');
    return artifactId;
  };
  const beforeUnreviewed = releaseChecks;
  const unreviewed = await start('builtin:full-trust');
  const installReview = await pendingApproval('machines.agents.install');
  expect(releaseChecks).toBe(beforeUnreviewed);
  expect(await action('approval.request.decide', { artifactId: installReview, decision: 'reject' }, true))
    .toMatchObject({ ok: true });
  expect(await account.execute('workflow.run.wait', { runId: unreviewed.id, conditions: ['terminal'] }))
    .toMatchObject({ ok: true, result: { observation: 'terminal' } });

  denyRelease = false;
  const reviewed = await start('builtin:apply-safe');
  const sessionReview = await pendingApproval('session.spawn_new');
  expect(await action('approval.request.decide', { artifactId: sessionReview, decision: 'approve' }, true))
    .toMatchObject({ ok: true });
  await waitFor(async () => {
    const installed = await action('machines.agents.list', { machineId, agentId: 'codex', refresh: true });
    if (!installed.ok) throw new Error(installed.errorCode);
    return MachinesAgentsListOutputSchema.parse(installed.result).items.some(item => item.agentId === 'codex' && item.installed);
  }, { timeoutMs: 60_000, context: 'approved Workflow native Agent installation' });
  expect(releaseChecks).toBeGreaterThan(beforeUnreviewed);
  expect(await account.execute('approval.request.list', { status: 'open', actionId: 'machines.agents.install' }))
    .toMatchObject({ ok: true, result: { items: [] } });
  const current = await account.execute('workflow.run.get', { runId: reviewed.id });
  if (!current.ok) throw new Error(current.errorCode);
  const { run: latest } = WorkflowRunGetResultV1Schema.parse(current.result);
  expect(await account.execute('workflow.run.cancel', { runId: reviewed.id, expectedRevision: latest.revision }))
    .toMatchObject({ ok: true });
}, 0);
