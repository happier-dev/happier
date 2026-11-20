import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestPublicSettlementSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SessionTranscriptGetSemanticSuccessSchema } from '@happier-dev/protocol/actions/specs/session/transcript';
import { MachinePresetActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetRecipientCensusResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { sealManagedMachinePresetContentV1, type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { MachineIsolationGetResultV1Schema } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import { ManagedListOutputV1Schema, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionWorkspaceReturnPreviewV1Schema } from '@happier-dev/protocol/actions/specs/session/projectFilesReturn';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityCollectionWritersClaimActionInputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';
import { projectBundledPluginUiDeclaration } from '../../../../apps/cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';
import { installBundledPluginUiDeclarationsForTests } from '@happier-tests/ui-action-client';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const testDir = run.testDir(`sandbox-journeys-${randomUUID()}`);
const contribution = { pluginId: 'happier.devcontainer', localId: 'devcontainer' };
const declarationClaimPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'];
let fixture: TeamSetupFFixture | undefined;
let database: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | undefined;
let account: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
let machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
let controller: { machineId: string; installationId: string };
let ui: Awaited<ReturnType<typeof import('@happier-tests/ui-action-client').connectUiPersonActionClient>> | undefined;
const sessionIds = new Set<string>();
let restorePackagedDeclarations: (() => void) | undefined;

beforeAll(async () => {
  const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
  if (!process.env.HAPPIER_TEST_SANDBOX_IMAGE) throw new Error('Supply a Docker image with glibc, git, sh and tar');
  // The Node UI harness replaces Expo assets; use the app build's declaration producer.
  const manifest = PluginManifestV2LoadSchema.parse(JSON.parse(await readFile(resolve(repoRootDir(),
    'apps/cli/assets/bundled-plugin-manifests/devcontainer.json'), 'utf8')));
  restorePackagedDeclarations = installBundledPluginUiDeclarationsForTests([await projectBundledPluginUiDeclaration({
    packageName: '@happier-dev/plugins-devcontainer', packageVersion: manifest.version, manifest, artifactGraphs: [],
  })]);
  await mkdir(testDir, { recursive: true });
  const fakeAgent = join(testDir, 'sandbox-claude');
  execFileSync('cc', [resolve(repoRootDir(), 'packages/tests/fixtures/machines/sandbox-claude.c'), '-o', fakeAgent]);
  database = databaseUrl ? undefined : await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
  fixture = await startTeamSetupFFixture({ testDir, serverEnv: { DATABASE_URL: databaseUrl ?? database!.homeDatabaseUrl },
    requestBodyMaxBytes: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
    captureRequestBody: request => request.method === 'POST' && request.path === declarationClaimPath });
  account = await fixture.createAccount('sandbox-owner');
  machine = await fixture.enrollDaemon(account, { env: { HAPPIER_CLAUDE_PATH: fakeAgent } });
}, 0);

beforeEach(async () => {
  if (!fixture) throw new Error('Fixture not started');
  // One person keeps the same App Account lifetime throughout the journey.
  const { connectUiPersonActionClient } = await import('@happier-tests/ui-action-client');
  ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
  try {
    const execution = await ui.executeConfirmed('machines.list', { serverId: fixture.serverId }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: ui.serverId,
      serverIdentityId: fixture.serverId, actionRequestId: randomUUID(),
    });
    expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true });
    if (!execution.ok) throw new Error(`machines.list: ${execution.errorCode}`);
    const outputSchema = getActionSpec('machines.list').outputSchema;
    if (!outputSchema) throw new Error('Machine list has no canonical output schema');
    const listed = outputSchema.parse(execution.result);
    if (!listed || typeof listed !== 'object' || !('items' in listed) || !Array.isArray(listed.items)) {
      throw new Error('Machine list has no items array');
    }
    const items: unknown[] = listed.items;
    const row = items.find(value => value && typeof value === 'object' && 'machineId' in value
      && value.machineId === machine.target.machineId);
    if (!row || typeof row !== 'object' || !('installationId' in row)
      || typeof row.installationId !== 'string' || !row.installationId) {
      throw new Error(`Enrolled Machine inventory mismatch: ${JSON.stringify({ listed,
        expectedMachineId: machine.target.machineId, requestedServerId: fixture.serverId, uiServerId: ui.serverId,
        expectedAccountId: readAccountIdFromToken(account.credentials.token),
      })}`);
    }
    controller = { machineId: machine.target.machineId, installationId: row.installationId };
    await ui.waitForPluginAccountAvailability();
  } catch (error) {
    await ui.close();
    ui = undefined;
    throw error;
  }
}, 0);

afterEach(async () => {
  try {
    if (fixture && account && ui) {
      for (const sessionId of sessionIds) await action('session.stop', { sessionId });
      for (const managed of await resources()) {
        await action('machines.managed.delete', { homeId: fixture.serverId, managedId: managed.id, when: 'now',
          expectedRevision: managed.intentRevision, intent: 'delete', reviewedDependencies: true });
      }
    }
  } finally {
    try { await ui?.close(); }
    finally {
      ui = undefined;
      sessionIds.clear();
    }
  }
}, 0);

afterAll(async () => {
  try {
    try { await fixture?.stop(); }
    finally { await database?.stop(); }
  }
  finally {
      const requests = fixture?.requestProxy?.entries() ?? [];
      for (const request of requests) {
        if (request.method !== 'POST' || request.path !== declarationClaimPath || !request.body) continue;
        const { byteLength, complete, truncated, text } = request.body;
        if (!complete || truncated) {
          console.log('MACH-J8 declaration claim', JSON.stringify({ byteLength, complete, truncated, pluginId: null,
            issues: [{ code: complete ? 'capture_truncated' : 'capture_incomplete', path: [] }] }));
          continue;
        }
        let body: unknown;
        try { body = JSON.parse(text); }
        catch {
          console.log('MACH-J8 declaration claim', JSON.stringify({ byteLength, complete, truncated, pluginId: null,
            issues: [{ code: 'invalid_json', path: [] }] }));
          continue;
        }
        const parsed = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.safeParse(body);
        const manifest = body && typeof body === 'object' && 'manifest' in body ? body.manifest : null;
        const pluginId = manifest && typeof manifest === 'object' && 'id' in manifest && typeof manifest.id === 'string'
          ? manifest.id : body && typeof body === 'object' && 'pluginId' in body && typeof body.pluginId === 'string'
            ? body.pluginId : null;
        console.log('MACH-J8 declaration claim', JSON.stringify({ byteLength, complete, truncated, pluginId,
          issues: parsed.success ? [] : parsed.error.issues.flatMap(issue => issue.code === 'invalid_union'
            ? issue.errors.flat().map(({ code, path }) => ({ code, path }))
            : [{ code: issue.code, path: issue.path }]) }));
      }
      fixture?.requestProxy?.clear();
      restorePackagedDeclarations?.();
  }
}, 0);

async function action(id: ActionId, input: unknown) {
  if (!ui || !fixture) throw new Error('Person UI client not connected');
  const result = await ui.executeConfirmed(id, input, {
    surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: ui.serverId,
    serverIdentityId: fixture.serverId, actionRequestId: randomUUID(),
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`${id}: ${result.errorCode}`);
  return result.result;
}

async function resources(presetId?: string) {
  const listed = ManagedListOutputV1Schema.parse(await action('machines.managed.list', { homeId: fixture!.serverId,
    ...(presetId ? { presetId } : {}) }));
  return listed.machines.map(unwrapManagedMachineReadV1);
}

function containerId(managedId: string) {
  const ids = execFileSync('docker', ['ps', '--all', '--filter', `label=happier.managed-machine=${managedId}`,
    '--format', '{{.ID}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

async function createPreset(name: string, extra: Partial<ManagedMachinePresetContentV1> = {}) {
  if (!fixture) throw new Error('Fixture not started');
  const id = randomUUID();
  const owner = { kind: 'account' as const, accountId: readAccountIdFromToken(account.credentials.token)! };
  const response = await fetch(`${fixture.server.baseUrl}/v1/machines/presets/recipient-census`, {
    method: 'POST', headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ homeId: fixture.serverId, owner, controller }),
  });
  expect(response.status).toBe(200);
  const census = ManagedMachinePresetRecipientCensusResultV1Schema.parse(await response.json());
  if (census.kind !== 'ready') throw new Error(`Preset census refused: ${census.code}`);
  const content: ManagedMachinePresetContentV1 = { v: 1, name, launch: { provider: contribution, schemaVersion: 1, name,
    choices: { runtime: 'docker', configuration: { kind: 'image', image: process.env.HAPPIER_TEST_SANDBOX_IMAGE! } } }, ...extra };
  const sealed = sealManagedMachinePresetContentV1({ presetId: id, mode: 'e2ee', content, recipientCensus: census.recipients,
    randomBytes: length => new Uint8Array(randomBytes(length)) });
  const saved = MachinePresetActionOutputSchemasV1['machines.presets.create'].parse(await action('machines.presets.create', {
    id, homeId: fixture.serverId, owner, controller, contentEncryptionMode: 'e2ee', ...sealed,
  }));
  expect(saved.kind).toBe('saved');
  if (saved.kind !== 'saved') throw new Error(`Preset save refused: ${JSON.stringify(saved)}`);
  return { preset: saved.preset, content, census };
}

async function configure(presetId: string, lifecycle: 'fresh' | 'shared-kept' = 'fresh') {
  const current = MachineIsolationGetResultV1Schema.parse(await action('machines.isolation.get', machine.target));
  if (current.status !== 'ready') throw new Error(`Isolation read: ${current.status}`);
  expect(await action('machines.isolation.set', { ...machine.target, expectedPolicy: current.policy,
    expectedMetadataVersion: current.metadataVersion, policy: { ...current.policy,
      configuredSandboxes: { journey: { provisioner: contribution, presetId } },
      workKinds: { ...current.policy.workKinds, sessions: { kind: 'sandbox', configuredSandboxId: 'journey', lifecycle } },
    } })).toMatchObject({ status: expect.stringMatching(/^(applied|satisfied|unchanged)$/) });
}

async function updatePreset(saved: Awaited<ReturnType<typeof createPreset>>, content: ManagedMachinePresetContentV1) {
  const sealed = sealManagedMachinePresetContentV1({ presetId: saved.preset.id, mode: 'e2ee', content,
    recipientCensus: saved.census.recipients, randomBytes: length => new Uint8Array(randomBytes(length)) });
  const result = MachinePresetActionOutputSchemasV1['machines.presets.update'].parse(await action('machines.presets.update', {
    homeId: fixture!.serverId, id: saved.preset.id, expectedRevision: saved.preset.revision,
    patch: { content: sealed.content, recipients: sealed.recipients },
  }));
  expect(result.kind).toBe('saved');
  if (result.kind !== 'saved') throw new Error(`Preset update: ${JSON.stringify(result)}`);
  return { ...saved, preset: result.preset, content };
}

async function archiveSession(sessionId: string) {
  await action('session.stop', { sessionId });
  await action('session.archive', { sessionId });
  sessionIds.delete(sessionId);
}

async function spawn(directory: string) {
  const created = SessionSpawnNewActionResultV1Schema.parse(await action('session.spawn_new', { executionTarget: machine.target,
    directory: { kind: 'path', path: directory }, terminal: { mode: 'plain' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    initialInput: { text: 'Observe the Project files and make the fixture edit.' },
    sessionPlacement: { kind: 'machine', target: machine.target, projectFiles: { kind: 'copy_once' } },
  }));
  expect(created, JSON.stringify(created)).toMatchObject({ type: 'success' });
  if (created.type !== 'success') throw new Error(`Session creation: ${JSON.stringify(created)}`);
  sessionIds.add(created.sessionId);
  return created.sessionId;
}

it('MACH-J1 adds a Docker sandbox, copies uncommitted Project files and brings back only reviewed work', async () => {
  const { preset } = await createPreset('Copy once journey', { setup: {
    scripts: [{ body: 'printf setup-complete > /tmp/journey-setup', affects: 'none' }],
  } });
  await configure(preset.id);
  const project = join(machine.workspaceDir, 'copy-once');
  await mkdir(project, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'Journey'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'journey@example.test'], { cwd: project });
  await writeFile(join(project, 'README.md'), 'committed\n');
  execFileSync('git', ['add', 'README.md'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: project });
  const hostConfig = await readFile(join(project, '.git/config'), 'utf8');
  await writeFile(join(project, 'host-sentinel.txt'), 'uncommitted sentinel\n');
  const sessionId = await spawn(project);
  let preview: ReturnType<typeof SessionWorkspaceReturnPreviewV1Schema.parse> | undefined;
  await waitFor(async () => {
    preview = SessionWorkspaceReturnPreviewV1Schema.parse(await action('session.workspace.return.prepare', { sessionId,
      machineId: machine.target.machineId }));
    return preview.paths.some(path => path.path === 'agent-edit.txt');
  }, { timeoutMs: 60_000, context: 'sandbox Agent observes uncommitted files and edits copied Project' });
  expect(preview!.paths.map(path => path.path)).toEqual(expect.arrayContaining(['agent-observed.txt', 'agent-edit.txt']));
  expect(preview!.paths.every(path => path.path !== '.git' && !path.path.startsWith('.git/'))).toBe(true);
  const [managed] = await resources(preset.id);
  expect(execFileSync('docker', ['exec', containerId(managed!.id), 'cat', '/tmp/journey-setup'], { encoding: 'utf8' }))
    .toBe('setup-complete');
  // This native Agent fixture needs no JavaScript runtime. Inspect executables,
  // since the holder's Agent arguments include daemon-related MCP permissions.
  const processExecutables = execFileSync('docker', ['top', containerId(managed!.id), '-eo', 'pid,exe'], { encoding: 'utf8' })
    .trim().split('\n').slice(1).map(line => line.trim().replace(/^\d+\s+/, ''));
  expect(processExecutables).not.toEqual(expect.arrayContaining([
    expect.stringMatching(/(?:^|\/)(?:happier|happier-session-runner|ephemeralRunner|node|bun)(?:\.exe)?$/),
  ]));
  const applied = await action('session.workspace.return.apply', { sessionId, machineId: machine.target.machineId,
    returnId: preview!.returnId, paths: ['agent-observed.txt', 'agent-edit.txt'] });
  expect(applied).toMatchObject({ appliedPaths: expect.arrayContaining(['agent-observed.txt', 'agent-edit.txt']), conflicts: [] });
  expect(await readFile(join(project, 'agent-observed.txt'), 'utf8')).toBe('uncommitted sentinel\n');
  expect(await readFile(join(project, 'agent-edit.txt'), 'utf8')).toBe('edit from the sandbox agent\n');
  expect(await readFile(join(project, '.git/config'), 'utf8')).toBe(hostConfig);
  await expect(readFile(join(project, '.git/hooks/pre-commit'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 0);

it('MACH-J9 routes the Git panel directory request into its placed Session without executing host git', async () => {
  const { preset } = await createPreset('Directory Git journey');
  await configure(preset.id);
  const project = join(machine.workspaceDir, 'directory-git');
  await mkdir(project, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'Journey'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'journey@example.test'], { cwd: project });
  await writeFile(join(project, 'README.md'), 'committed\n');
  execFileSync('git', ['add', 'README.md'], { cwd: project });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: project });
  await writeFile(join(project, 'host-sentinel.txt'), 'directory-only source\n');
  const sessionId = await spawn(project);
  await waitFor(async () => {
    const preview = SessionWorkspaceReturnPreviewV1Schema.parse(await action('session.workspace.return.prepare', {
      sessionId, machineId: machine.target.machineId }));
    return preview.paths.some(path => path.path === 'agent-edit.txt');
  }, { timeoutMs: 60_000, context: 'directory Git Session primary Agent holder ready' });
  const monitor = join(project, '.git/hooks/host-monitor');
  await writeFile(monitor, '#!/bin/sh\nprintf host > .git/host-git-ran\n');
  await chmod(monitor, 0o755);
  execFileSync('git', ['config', 'core.fsmonitor', monitor], { cwd: project });
  // This is the Git panel's directory-keyed request: there is deliberately no
  // Session operand for the daemon to use as a shortcut.
  const result = await account.execute('scm.status.snapshot', { cwd: project }, {
    externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { success: true } });
  expect(JSON.stringify(result)).toContain('agent-edit.txt');
  await expect(readFile(join(project, '.git/host-git-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 0);

it('MACH-J3 reuses a shared-kept guest after rename and never borrows the intermediate B guest for C', async () => {
  let saved = await createPreset('Shared A');
  await configure(saved.preset.id, 'shared-kept');
  const project = join(machine.workspaceDir, 'shared-kept');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'host-sentinel.txt'), 'shared-kept sentinel\n');
  const first = await spawn(project);
  const [a] = await resources(saved.preset.id);
  expect(a).toBeDefined();
  const aContainer = containerId(a!.id);
  await archiveSession(first);

  saved = await updatePreset(saved, { ...saved.content, name: 'Renamed A' });
  const renamed = await spawn(project);
  expect(await resources(saved.preset.id)).toMatchObject([{ id: a!.id }]);
  expect(containerId(a!.id)).toBe(aContainer);
  await archiveSession(renamed);

  saved = await updatePreset(saved, { ...saved.content, setup: {
    scripts: [{ body: 'printf B > /tmp/journey-configuration', affects: 'none' }],
  } });
  const second = await spawn(project);
  const b = (await resources(saved.preset.id)).find(row => row.id !== a!.id);
  expect(b).toBeDefined();
  const bContainer = containerId(b!.id);
  await archiveSession(second);

  saved = await updatePreset(saved, { ...saved.content, setup: {
    scripts: [{ body: 'printf C > /tmp/journey-configuration', affects: 'none' }],
  } });
  await spawn(project);
  const all = await resources(saved.preset.id);
  expect(all).toHaveLength(3);
  const c = all.find(row => row.id !== a!.id && row.id !== b!.id);
  expect(c).toBeDefined();
  expect(containerId(c!.id)).not.toBe(bContainer);
});

/** The public CLI Action executor owns signing/admission; approval is settled
 * through the person's real UI executor, never by a test dispatcher. */
async function publicAction(id: ActionId, input: unknown) {
  let execution = await account.execute(id, input);
  const approval = execution.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(execution.result) : null;
  if (approval?.success) {
    await action('approval.request.decide', { artifactId: approval.data.artifactId, decision: 'approve' });
    const outputSchema = getActionSpec('approval.request.get').outputSchema;
    if (!outputSchema) throw new Error('Approval read has no canonical output schema');
    const stored = outputSchema.parse(await action('approval.request.get', { artifactId: approval.data.artifactId }));
    if (!stored || typeof stored !== 'object' || !('request' in stored)) throw new Error('Approval settlement missing');
    execution = ApprovalRequestPublicSettlementSchema.parse(stored.request).execution;
  }
  expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true });
  if (!execution.ok) throw new Error(`${id}: ${execution.errorCode}`);
  return execution.result;
}

it.each([
  { ingress: 'UI Action', execute: action },
  { ingress: 'public Action', execute: publicAction },
])('MACH-J8 $ingress sends, wakes, stops, starts and deletes the same managed owner', async ({ ingress, execute }) => {
  const startedAt = performance.now();
  const saved = await createPreset(`Ingress parity ${ingress}`);
  await configure(saved.preset.id, 'shared-kept');
  const project = join(machine.workspaceDir, `ingress-${randomUUID()}`);
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'host-sentinel.txt'), 'ingress parity sentinel\n');
  const sessionId = await spawn(project);
  const [initial] = await resources(saved.preset.id);
  if (!initial) throw new Error('Session placement did not create its managed resource');
  expect(initial.controller).toEqual(controller);
  expect(initial.enrolledMachineId).toBeTruthy();
  const nativeId = containerId(initial.id);
  const target = { homeId: fixture!.serverId, managedId: initial.id };
  const read = async () => {
    const rows = await resources(saved.preset.id);
    const row = rows.find(candidate => candidate.id === initial.id);
    if (!row) throw new Error('Managed owner disappeared before explicit Delete');
    return row;
  };
  const running = () => execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', nativeId],
    { encoding: 'utf8' }).trim() === 'true';
  const power = async (intent: 'start' | 'stop') => {
    const row = await read();
    expect(await execute('machines.managed.power.set', { ...target, when: 'now', intent,
      expectedRevision: row.intentRevision })).toMatchObject({ kind: 'accepted', managedId: initial.id });
    await waitFor(() => running() === (intent === 'start'),
      { timeoutMs: 60_000, context: `${ingress} native sandbox ${intent} settles` });
    expect(running()).toBe(intent === 'start');
    return row.intentRevision;
  };
  const transcript = async () => SessionTranscriptGetSemanticSuccessSchema.parse(
    await action('session.transcript.get', { sessionId, roles: ['user', 'assistant'] }));

  // Do not allow the initial reply to stand in for a reply after wake.
  await waitFor(async () => (await transcript()).items.some(item => item.role === 'assistant'),
    { timeoutMs: 60_000, context: `${ingress} initial sandbox reply` });
  const row = await read();
  await action('machines.managed.retention.update', { ...target, expectedIntentRevision: row.intentRevision,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
  expect(await read()).toMatchObject({ id: initial.id, wakeOnAcceptedMessage: true });
  const staleRevision = await power('stop');
  const prompt = `Wake ingress parity ${ingress} ${randomUUID()}`;
  await execute('session.message.send', { sessionId, message: prompt });
  await waitFor(async () => {
    const page = await transcript();
    const sent = page.items.find(item => item.role === 'user' && item.text === prompt);
    return sent?.seq !== undefined && page.items.some(item => item.role === 'assistant'
      && item.seq !== undefined && item.seq > sent.seq!);
  }, { timeoutMs: 60_000, context: `${ingress} accepted Send wakes sandbox and produces its next reply` });
  expect(running()).toBe(true);
  expect(containerId(initial.id)).toBe(nativeId);
  expect(await execute('machines.managed.power.set', { ...target, when: 'now', intent: 'stop',
    expectedRevision: staleRevision })).toMatchObject({ kind: 'conflict', currentRevision: (await read()).intentRevision });
  expect(running()).toBe(true);

  await power('stop');
  await power('start');
  expect(containerId(initial.id)).toBe(nativeId);
  await archiveSession(sessionId);
  const beforeDelete = await read();
  expect(await execute('machines.managed.delete', { ...target, when: 'now', intent: 'delete',
    expectedRevision: beforeDelete.intentRevision, reviewedDependencies: true }))
    .toMatchObject({ kind: 'accepted', managedId: initial.id });
  await waitFor(async () => {
    const nativeExists = execFileSync('docker', ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${nativeId}`],
      { encoding: 'utf8' }).trim() !== '';
    const managed = await read();
    return !nativeExists && managed.allocation === 'confirmed-absent' && managed.desired === 'delete';
  }, { timeoutMs: 60_000, context: `${ingress} native sandbox deletion and Home result settle` });
  expect(await read()).toMatchObject({ allocation: 'confirmed-absent', desired: 'delete' });
  console.info(JSON.stringify({ journey: 'MACH-J8', ingress, runtimeMs: Math.round(performance.now() - startedAt), testDir }));
}, 0);
