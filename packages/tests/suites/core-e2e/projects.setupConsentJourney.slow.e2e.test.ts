import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { PROJECT_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectCommandSourceV1, ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { fetchJson } from '../../src/testkit/http';

const testDir = createRunDirs({ runLabel: 'project-consent-journey' }).testDir(randomUUID());
let fixture: ProjectDaemonFixture | undefined;
let account: Awaited<ReturnType<ProjectDaemonFixture['createAccount']>>;
let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
let machineId: string;

beforeAll(async () => {
  const bin = join(testDir, 'bin');
  await mkdir(bin, { recursive: true });
  // Mise is an external process boundary. The fixture preserves real environment
  // capture and command execution; it replaces only acquiring the vendor binary.
  await writeFile(join(bin, 'mise'), [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) printf "%s\\n" "2026.10.4 linux-x64 (2026-10-14)" ;;',
    '  exec) . "${MISE_OVERRIDE_CONFIG_FILENAMES%/*}/env.sh"; shift 2; exec "$@" ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  fixture = await startProjectDaemonFixture({ testDir });
  account = await fixture.createAccount('setup-owner');
  const enrolled = await fixture.enrollDaemon(account, { env: { PATH: [bin, process.env.PATH].join(delimiter) } });
  machineId = enrolled.target.machineId;
}, 0);

beforeEach(async () => {
  if (!fixture) throw new Error('Setup journey Home did not start');
  // The UI boundary resets device profiles before each scenario. Sign in
  // afterward, while retaining the real shared Home and enrolled daemon.
  ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
  try {
    await waitFor(() => {
      if (!ui!.isAccountReady()) throw new Error('UI Account is not ready');
      if (!ui!.isMachineActive(machineId)) throw new Error('Enrolled Machine is not active in the UI');
      return true;
    }, { timeoutMs: 60_000, context: 'per-scenario UI reconnect to the shared Home and daemon' });
  } catch (error) {
    // Report only membership/liveness, never the census's keys or content.
    const census = await fetchJson<unknown>(`${fixture.server.baseUrl}/v1/machines?includeRevoked=true`, {
      headers: { Authorization: `Bearer ${account.auth.token}` },
    });
    const rows: readonly unknown[] = Array.isArray(census.data) ? census.data : [];
    const enrolled = rows.find((row): row is Record<string, unknown> => typeof row === 'object' && row !== null
      && 'id' in row && row.id === machineId);
    throw new Error(`${error instanceof Error ? error.message : 'UI reconnect failed'}; Home census status=${census.status}, enrolled=${Boolean(enrolled)}, active=${enrolled?.active === true}`);
  }
}, 0);

afterEach(async () => {
  try {
    console.info('Setup consent phase', { phase: 'ui_close_started' });
    await ui?.close();
    console.info('Setup consent phase', { phase: 'ui_close_completed' });
  } finally { ui = undefined; }
}, 0);
afterAll(async () => { await fixture?.stop(); }, 0);

function personActionContext(serverId: string) {
  return { surface: 'ui' as const, authority: 'present_user' as const, serverId,
    serverIdentityId: fixture!.serverId, actionRequestId: randomUUID(), actionCaller: { kind: 'host' as const } };
}

async function executeAction(id: Parameters<NonNullable<typeof ui>['executePresented']>[0], input: unknown) {
  if (!ui) throw new Error('Person Action connection unavailable');
  if (id === 'projects.open') console.info('Setup consent phase', { phase: 'ui_open_started' });
  const result = await ui.executePresented(id, input, personActionContext(ui.serverId));
  if (id === 'projects.open') console.info('Setup consent phase', { phase: 'ui_open_completed' });
  return result;
}

async function prepareThroughInbox(input: unknown) {
  const person = ui;
  if (!person) throw new Error('Person Action connection unavailable');
  // The mounted person retains the accepted checkout while answering the terminal's Ask.
  return account.executeWithApproval('projects.prepare', input, artifactId =>
    person.executeConfirmed('approval.request.decide', { artifactId, decision: 'approve' }, personActionContext(person.serverId)));
}

async function action(id: Parameters<NonNullable<typeof ui>['executePresented']>[0], input: unknown) {
  const result = await executeAction(id, input);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.errorCode);
  return result.result;
}

async function observe(operationId: string, waitForTerminal = false) {
  const result = ActionOperationGetV1ResponseSchema.parse(await action('action.operations.get', {
    serverId: ui!.serverId, machineId, operationId, ...(waitForTerminal ? { waitForTerminal: true } : {}),
  }));
  if (result.kind !== 'found') throw new Error('Project operation not found');
  return result.operation;
}

async function expectSetupSucceeded(operationId: string, context: string) {
  const operation = await observe(operationId, true);
  expect(operation.state, `${context}: ${operation.error?.errorCode ?? operation.state}`).toBe('succeeded');
}

async function settledOrReview(operationId: string) {
  let operation: ActionOperationSnapshotV1 | undefined;
  await waitFor(async () => {
    operation = await observe(operationId);
    return Boolean(operation.setupReview) || ['succeeded', 'failed', 'cancelled'].includes(operation.state);
  }, { context: 'setup completes or requests person review' });
  return operation!;
}

const cases: ReadonlyArray<{
  name: string;
  source: ProjectCommandSourceV1;
  files: Readonly<Record<string, string>>;
  changedFile: string;
  changedBytes: string;
  toolchain?: ProjectManifestV1['toolchain'];
}> = [
  { name: 'literal script', source: { kind: 'command', command: 'sh setup.sh' },
    files: { 'setup.sh': 'printf original >> effects\n', 'teardown.sh': 'printf removed >> teardown-effects\n' }, changedFile: 'setup.sh', changedBytes: 'printf changed >> effects\n' },
  { name: 'interpreter flags', source: { kind: 'command', command: 'bash -e setup.sh' },
    files: { 'setup.sh': 'printf original >> effects\n' }, changedFile: 'setup.sh', changedBytes: 'printf changed >> effects\n' },
  { name: 'Node preload', source: { kind: 'command', command: 'node --require ./preload.cjs main.cjs' },
    files: { 'preload.cjs': "require('node:fs').appendFileSync('effects', 'original');\n", 'main.cjs': '' },
    changedFile: 'preload.cjs', changedBytes: "require('node:fs').appendFileSync('effects', 'changed');\n" },
  { name: 'native make task', source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'setup' },
    files: { Makefile: '.PHONY: setup\nsetup:\n\tsh setup.sh\n', 'setup.sh': 'printf original >> effects\n' },
    changedFile: 'setup.sh', changedBytes: 'printf changed >> effects\n' },
  { name: 'folder operand', source: { kind: 'command', command: 'node server' },
    files: { 'server/index.js': "require('node:fs').appendFileSync('effects', 'original');\n" },
    changedFile: 'server/index.js', changedBytes: "require('node:fs').appendFileSync('effects', 'changed');\n" },
  { name: 'changed directory', source: { kind: 'command', command: 'cd scripts && ./x' },
    files: { 'scripts/x': '#!/bin/sh\nprintf original >> ../effects\n' }, changedFile: 'scripts/x', changedBytes: '#!/bin/sh\nprintf changed >> ../effects\n' },
  { name: 'toolchain loaded file', source: { kind: 'command', command: 'sh setup.sh' },
    toolchain: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' },
    files: { 'mise.toml': '[env]\n_.source = ["./env.sh"]\n', 'env.sh': 'export INPUT=original\n', 'setup.sh': 'printf "%s" "$INPUT" >> effects\n' },
    changedFile: 'env.sh', changedBytes: 'export INPUT=changed\n' },
];

it.skipIf(process.platform === 'win32').each(cases)('remembers setup consent then re-prompts when $name changes', async (scenario) => {
  const root = join(testDir, randomUUID());
  await mkdir(join(root, '.happier'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  for (const [file, bytes] of Object.entries(scenario.files)) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes, { mode: 0o755 });
  }
  const manifestPath = join(root, '.happier/project.json');
  const manifest = { version: 1,
    ...(scenario.toolchain ? { toolchain: scenario.toolchain } : {}), workspace: { setup: [scenario.source],
      ...(scenario.name === 'literal script' ? { teardown: [{ kind: 'command', command: 'sh teardown.sh' }] } : {}) } };
  await writeFile(manifestPath, JSON.stringify({ version: 1,
    workspace: { setup: [{ kind: 'command', command: 'printf control > control-effects' }] } }));
  const opened = OpenProjectResultV1Schema.parse(await action('projects.open', { serverId: ui!.serverId, machineId,
    source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }));
  expect(opened.kind).toBe('opened');
  if (opened.kind !== 'opened') throw new Error('Project did not open');
  const workspace = opened.workspace;
  const projectId = opened.facts?.projectKey;
  if (!projectId) throw new Error('Opened Project identity unavailable');
  const trust = async () => PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.trust.list'].parse(await action('projects.trust.list', {
    project: { serverId: ui!.serverId, projectId },
  })).trust;
  // The CLI requester passes its real Inbox review before its setup operation
  // can hold for the person's separate This time / Remember decision in the UI.
  // An initial own-UI press already consents to this invocation's setup effect.
  const prepare = async () => {
    const result = await prepareThroughInbox({ workspace, phase: 'setup' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    return ProjectCommandActionOutputV1Schema.parse(result.result).operation;
  };
  // The same checkout/principal first completes an ordinary supported setup.
  // A later refusal is meaningful only after this real control has succeeded.
  const control = await prepare();
  const controlReview = await settledOrReview(control.operationId);
  expect(controlReview.setupReview).toBeDefined();
  await action('projects.prepare', { workspace, phase: 'setup', heldOperationId: control.operationId,
    expectedEffectDigest: controlReview.setupReview!.reviewedEffectDigest, consentScope: 'thisTime' });
  await expectSetupSucceeded(control.operationId, 'same-fixture known-good setup control');
  expect(await readFile(join(root, 'control-effects'), 'utf8')).toBe('control');
  expect(await trust()).toEqual([]);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const first = await prepare();
  const pending = await settledOrReview(first.operationId);
  expect(pending.setupReview?.code).toBe('project_setup_consent_required');
  const digest = pending.setupReview!.reviewedEffectDigest;
  const consent = { workspace, phase: 'setup' as const, heldOperationId: first.operationId,
    expectedEffectDigest: digest, consentScope: 'untilChanged' as const };
  if (scenario.name === 'literal script') {
    // The CLI decision must consume the same captured approval. Re-dispatching
    // prepare changes its signed origin and conflicts before Trust is written.
    const rememberedConsent = await prepareThroughInbox(consent);
    expect(rememberedConsent.ok, JSON.stringify(rememberedConsent)).toBe(true);
    if (!rememberedConsent.ok) throw new Error(rememberedConsent.errorCode);
    expect(ProjectCommandActionOutputV1Schema.parse(rememberedConsent.result).operation.operationId).toBe(first.operationId);
  } else await action('projects.prepare', consent);
  await expectSetupSucceeded(first.operationId, 'approved setup succeeds');
  expect(await readFile(join(root, 'effects'), 'utf8')).toBe('original');
  expect(await trust()).toMatchObject([{ value: { reviewedEffectDigest: digest } }]);

  const remembered = await settledOrReview((await prepare()).operationId);
  expect(remembered.state).toBe('succeeded');
  expect(remembered.setupReview).toBeUndefined();
  expect(await readFile(join(root, 'effects'), 'utf8')).toBe('original');

  await writeFile(join(root, scenario.changedFile), scenario.changedBytes);
  const changed = await settledOrReview((await prepare()).operationId);
  expect(changed.setupReview?.reviewedEffectDigest).toBeTruthy();
  expect(changed.setupReview?.reviewedEffectDigest).not.toBe(digest);
  expect(changed.state).not.toBe('succeeded');
  expect(await readFile(join(root, 'effects'), 'utf8')).toBe('original');
  // A stale approval must not execute the new bytes. The next explicit person
  // decision uses the current review, so the journey proves recovery too.
  const staleApproval = await executeAction('projects.prepare', { workspace, phase: 'setup', heldOperationId: changed.operationId,
    expectedEffectDigest: digest, consentScope: 'thisTime' });
  expect(staleApproval).toMatchObject({ ok: false, errorCode: 'project_setup_effect_changed' });
  const refused = await observe(changed.operationId);
  expect(refused.state).not.toBe('succeeded');
  expect(refused.setupReview?.reviewedEffectDigest).toBe(changed.setupReview!.reviewedEffectDigest);
  expect(await readFile(join(root, 'effects'), 'utf8')).toBe('original');
  expect(await trust()).toMatchObject([{ value: { reviewedEffectDigest: digest } }]);
  await action('projects.prepare', { workspace, phase: 'setup', heldOperationId: changed.operationId,
    expectedEffectDigest: refused.setupReview!.reviewedEffectDigest, consentScope: 'untilChanged' });
  await expectSetupSucceeded(changed.operationId, 'changed setup succeeds after fresh consent');
  expect(await readFile(join(root, 'effects'), 'utf8')).toBe('originalchanged');
  expect(await trust()).toMatchObject([{ value: { reviewedEffectDigest: refused.setupReview!.reviewedEffectDigest } }]);
  if (scenario.name === 'literal script') {
    await expect(readFile(join(root, 'teardown-effects'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const teardown = ProjectCommandActionOutputV1Schema.parse(await action('projects.prepare', { workspace, phase: 'teardown' })).operation;
    const rememberedTeardown = await settledOrReview(teardown.operationId);
    expect(rememberedTeardown.state).toBe('succeeded');
    expect(rememberedTeardown.setupReview).toBeUndefined();
    expect(await readFile(join(root, 'teardown-effects'), 'utf8')).toBe('removed');
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('originalchanged');
  }
}, 0);
