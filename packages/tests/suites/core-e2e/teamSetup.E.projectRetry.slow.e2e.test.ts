import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ClientActionFailureDetailsV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { SessionListActionResultV1Schema } from '@happier-dev/protocol/sessions/awareness/action';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'team-setup-e' });
const testDir = run.testDir(`project-retry-${randomUUID()}`);
let fixture: TeamSetupFFixture | undefined;
let account: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let machineId: string;

beforeAll(async () => {
  fixture = await startTeamSetupFFixture({ testDir });
  account = await fixture.createAccount('member');
  const enrolled = await fixture.enrollDaemon(account);
  machineId = enrolled.target.machineId;
});

// Each test connects after the shared UI device reset has run.
beforeEach(async () => {
  ui = await connectUiActionClient({ serverUrl: fixture!.server.baseUrl, credentials: account.uiCredentials });
  try {
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
  } catch (cause) {
    throw new Error(`UI readiness failed: ${JSON.stringify({ accountReady: ui.isAccountReady(),
      machineActive: ui.isMachineActive(machineId) })}`, { cause });
  }
});

afterEach(async () => { await ui?.close(); ui = undefined; });

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => ui?.close(), () => fixture?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Project retry fixture cleanup failed');
});

async function action(id: string, input: unknown, confirmed = false) {
  if (!ui) throw new Error('UI Action client not started');
  const result = await (confirmed ? ui.executeConfirmed : ui.execute)(id as Parameters<typeof ui.execute>[0], input,
    { surface: 'ui', authority: 'present_user', serverId: ui.serverId, actionCaller: { kind: 'host' } });
  const publicDetails = !result.ok ? ClientActionFailureDetailsV1Schema.safeParse(result.details) : null;
  expect(result.ok, result.ok ? undefined : JSON.stringify({ actionId: id, errorCode: result.errorCode,
    failureCause: result.failureCause, details: publicDetails?.success ? publicDetails.data : 'opaque_details_omitted' })).toBe(true);
  if (!result.ok) throw new Error(result.errorCode);
  return result.result;
}

async function observe(operationId: string) {
  const found = ActionOperationGetV1ResponseSchema.parse(await action('action.operations.get', {
    serverId: ui!.serverId, machineId, operationId,
  }));
  if (found.kind !== 'found') throw new Error('Accepted project operation not found');
  return found.operation;
}

async function settle(operationId: string) {
  let snapshot: ActionOperationSnapshotV1 | undefined;
  await waitFor(async () => {
    snapshot = await observe(operationId);
    return snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled';
  });
  return snapshot!;
}

async function sessions() {
  return SessionListActionResultV1Schema.parse(await action('session.list', { query: {
    v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [],
  } })).sessions;
}

it('TS.E.projectRetry repeats no confirmed command after failure and requires review for changed inputs', async () => {
  const root = join(testDir, 'project');
  await mkdir(join(root, '.happier'), { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'remote.origin.url', 'https://github.com/happier-dev/project-retry.git']);
  // These authored shell commands are actual finite processes on the Linux test host.
  const manifest = { version: 1, workspace: { setup: [
    { kind: 'command', command: 'printf first >> first-effects' },
    { kind: 'command', command: 'sh init-second.sh' },
  ] } };
  const executable = join(root, 'init-second.sh');
  await writeFile(executable, 'test -f allow-second && printf second >> second-effects\n');
  await writeFile(join(root, '.happier/project.json'), JSON.stringify(manifest));
  const opened = OpenProjectResultV1Schema.parse(await action('projects.open', { serverId: ui!.serverId, machineId,
    source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }, true));
  // P04 control: this supported admitted Action crosses the real UI executor,
  // PostgreSQL Home and daemon before the missing suffix behavior is asserted.
  expect(opened).toMatchObject({ kind: 'opened', workspace: {
    serverId: ui!.serverId, machineId, rootPath: root,
  } });
  if (opened.kind !== 'opened') throw new Error('Fixture Project did not open');
  const workspace = opened.workspace;
  if (!('machineId' in workspace)) throw new Error('Fixture checkout did not open on the member Machine');
  const selector = { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'happier-dev/project-retry', cloneUrl: 'https://github.com/happier-dev/project-retry.git' }, protocol: 'https' } as const;
  const savedSource = ProjectSourcesReadOutputV1Schema.parse(await action('projects.sources.create', {
    serverId: ui!.serverId, requestKey: randomUUID(), name: 'Retry repository', repository: selector,
  }, true));
  if (!savedSource.ok) throw new Error(`Fixture Project Source creation refused (${savedSource.error})`);
  const fromSource = OpenProjectResultV1Schema.parse(await action('projects.open', {
    serverId: ui!.serverId, machineId, source: { kind: 'source', id: savedSource.source.id,
      revision: savedSource.source.revision, selector, checkout: workspace }, materialization: { kind: 'attach' },
  }, true));
  expect(fromSource).toMatchObject({ kind: 'opened', workspace });
  let sourceOpen: ActionOperationSnapshotV1 | undefined;
  await waitFor(async () => {
    const listed = ActionOperationListV1ResponseSchema.parse(await action('action.operations.list', {
      serverId: ui!.serverId, machineId,
    }));
    sourceOpen = listed.items.find(operation => operation.actionId === 'projects.open'
      && operation.domainRef?.kind === 'projectOpen' && operation.domainRef.sourceId === savedSource.source.id);
    return sourceOpen?.state === 'succeeded';
  });
  expect(sourceOpen).toMatchObject({ state: 'succeeded', scope: { machineId, accountId: readAccountIdFromToken(account.credentials.token) },
    domainRef: { kind: 'projectOpen', sourceId: savedSource.source.id } });
  // Retained summaries identify this Source; its full owner read recovers Open's result.
  expect(sourceOpen!.result).toBeUndefined();
  expect((await observe(sourceOpen!.operationId)).result).toEqual(fromSource);
  const accepted = ProjectCommandActionOutputV1Schema.parse(await action('projects.prepare', { workspace, phase: 'setup' }, true)).operation;
  let review: ActionOperationSnapshotV1 | undefined;
  await waitFor(async () => { review = await observe(accepted.operationId); return Boolean(review.setupReview); });
  const reviewedEffectDigest = review!.setupReview!.reviewedEffectDigest;
  await action('projects.prepare', { workspace, phase: 'setup', heldOperationId: accepted.operationId,
    expectedEffectDigest: reviewedEffectDigest, consentScope: 'untilChanged' }, true);
  const failed = await settle(accepted.operationId);
  expect(failed).toMatchObject({ state: 'failed', error: { errorCode: 'project_setup_step_failed' } });
  expect(await readFile(join(root, 'first-effects'), 'utf8')).toBe('first');
  expect(await sessions()).toEqual([]);
  await writeFile(join(root, 'allow-second'), 'allow');
  const retry = ProjectCommandActionOutputV1Schema.parse(await action('projects.prepare', { workspace, phase: 'setup' }, true)).operation;
  const retried = await settle(retry.operationId);
  expect(retried.state).toBe('succeeded');
  expect(await readFile(join(root, 'first-effects'), 'utf8')).toBe('first');
  expect(await readFile(join(root, 'second-effects'), 'utf8')).toBe('second');
  expect(failed.domainRef).toMatchObject({ kind: 'projectCommand', terminalId: expect.any(String), steps: [
    { index: 0, state: 'succeeded' }, { index: 1, state: 'failed' },
  ] });
  expect(retried).toMatchObject({ state: 'succeeded', domainRef: {
    kind: 'projectCommand', terminalId: expect.any(String), steps: [
      { index: 0, state: 'succeeded' }, { index: 1, state: 'succeeded' },
    ],
  } });
  // Repo readiness offers an explicit Start Session; neither failed nor completed
  // setup starts an Agent. The existing fixture supplies the external Agent CLI.
  expect(await sessions()).toEqual([]);
  const updatedAtMs = Date.now();
  const started = SessionSpawnNewActionResultV1Schema.parse(await action('session.spawn_new', {
    executionTarget: { serverId: workspace.serverId, machineId: workspace.machineId },
    directory: { kind: 'path', path: workspace.rootPath },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    permissionMode: 'read-only', approvalProfileId: null,
    configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
      permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
    connectedServices: { v: 2, bindingsByServiceId: {} }, terminal: { mode: 'plain' },
  }, true));
  expect(started).toMatchObject({ type: 'success', executionTarget: {
    serverId: workspace.serverId, machineId: workspace.machineId,
  } });
  if (started.type !== 'success') throw new Error('Explicit ready-repo Session did not start');
  expect(await account.readSessionMetadata(started.sessionId)).toMatchObject({ machineId: workspace.machineId, path: workspace.rootPath });
  expect(await readFile(join(root, 'first-effects'), 'utf8')).toBe('first');
  expect(await readFile(join(root, 'second-effects'), 'utf8')).toBe('second');

  await writeFile(executable, 'printf changed >> first-effects\n');
  const changed = ProjectCommandActionOutputV1Schema.parse(await action('projects.prepare', { workspace, phase: 'setup' }, true)).operation;
  await waitFor(async () => { review = await observe(changed.operationId); return Boolean(review.setupReview); });
  await action('projects.prepare', { workspace, phase: 'setup', heldOperationId: changed.operationId,
    expectedEffectDigest: reviewedEffectDigest, consentScope: 'thisTime' }, true);
  expect((await observe(changed.operationId)).setupReview?.code).toBe('project_setup_effect_changed');
  expect(await readFile(join(root, 'first-effects'), 'utf8')).toBe('first');
});
