import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectCommandSourceV1, ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { startProjectDaemonFixture, type ProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const testDir = createRunDirs({ runLabel: 'project-consent-journey' }).testDir(randomUUID());
let fixture: ProjectDaemonFixture | undefined;
let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
let machineId: string;

beforeAll(async () => {
  const bin = join(testDir, 'bin');
  await mkdir(bin, { recursive: true });
  // Mise is an external process boundary. The fixture preserves real environment
  // capture and command execution; it replaces only acquiring the vendor binary.
  await writeFile(join(bin, 'mise'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2026.10.4 linux-x64"; exit; fi\nif [ "$1" = "exec" ]; then . "${MISE_OVERRIDE_CONFIG_FILENAMES%/*}/env.sh"; shift; shift; exec "$@"; fi\nexit 1\n', { mode: 0o755 });
  fixture = await startProjectDaemonFixture({ testDir });
  const account = await fixture.createAccount('setup-owner');
  const enrolled = await fixture.enrollDaemon(account, { env: { PATH: [bin, process.env.PATH].join(delimiter) } });
  machineId = enrolled.target.machineId;
  ui = await connectUiPersonActionClient({ serverUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
  await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
});

afterAll(async () => {
  try { await ui?.close(); } finally { await fixture?.stop(); }
});

async function action(id: Parameters<NonNullable<typeof ui>['executeConfirmed']>[0], input: unknown) {
  if (!ui) throw new Error('Person Action connection unavailable');
  const result = await ui.executeConfirmed(id, input, { surface: 'ui', authority: 'present_user', serverId: ui.serverId, actionCaller: { kind: 'host' } });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.errorCode);
  return result.result;
}

async function observe(operationId: string) {
  const result = ActionOperationGetV1ResponseSchema.parse(await action('action.operations.get', { serverId: ui!.serverId, machineId, operationId }));
  if (result.kind !== 'found') throw new Error('Project operation not found');
  return result.operation;
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
  const prepare = async () => ProjectCommandActionOutputV1Schema.parse(await action('projects.prepare', { workspace, phase: 'setup' })).operation;
  // The same checkout/principal first completes an ordinary supported setup.
  // A later refusal is meaningful only after this real control has succeeded.
  const control = await prepare();
  const controlReview = await settledOrReview(control.operationId);
  expect(controlReview.setupReview).toBeDefined();
  await action('projects.prepare', { workspace, phase: 'setup', heldOperationId: control.operationId,
    expectedEffectDigest: controlReview.setupReview!.reviewedEffectDigest, consentScope: 'thisTime' });
  await waitFor(async () => (await observe(control.operationId)).state === 'succeeded', { context: 'same-fixture known-good setup control' });
  expect(await readFile(join(root, 'control-effects'), 'utf8')).toBe('control');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const first = await prepare();
  const pending = await settledOrReview(first.operationId);
  expect(pending.setupReview?.code).toBe('project_setup_consent_required');
  const digest = pending.setupReview!.reviewedEffectDigest;
  await action('projects.prepare', { workspace, phase: 'setup', heldOperationId: first.operationId,
    expectedEffectDigest: digest, consentScope: 'untilChanged' });
  await waitFor(async () => (await observe(first.operationId)).state === 'succeeded', { context: 'approved setup succeeds' });
  expect(await readFile(join(root, 'effects'), 'utf8')).toBe('original');

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
  await action('projects.prepare', { workspace, phase: 'setup', heldOperationId: changed.operationId,
    expectedEffectDigest: digest, consentScope: 'thisTime' });
  const refused = await observe(changed.operationId);
  expect(refused.setupReview?.code).toBe('project_setup_effect_changed');
  expect(await readFile(join(root, 'effects'), 'utf8')).toBe('original');
  await action('projects.prepare', { workspace, phase: 'setup', heldOperationId: changed.operationId,
    expectedEffectDigest: refused.setupReview!.reviewedEffectDigest, consentScope: 'untilChanged' });
  await waitFor(async () => (await observe(changed.operationId)).state === 'succeeded', { context: 'changed setup succeeds after fresh consent' });
  expect(await readFile(join(root, 'effects'), 'utf8')).toBe('originalchanged');
  if (scenario.name === 'literal script') {
    await expect(readFile(join(root, 'teardown-effects'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const teardown = ProjectCommandActionOutputV1Schema.parse(await action('projects.prepare', { workspace, phase: 'teardown' })).operation;
    const rememberedTeardown = await settledOrReview(teardown.operationId);
    expect(rememberedTeardown.state).toBe('succeeded');
    expect(rememberedTeardown.setupReview).toBeUndefined();
    expect(await readFile(join(root, 'teardown-effects'), 'utf8')).toBe('removed');
    expect(await readFile(join(root, 'effects'), 'utf8')).toBe('originalchanged');
  }
});
