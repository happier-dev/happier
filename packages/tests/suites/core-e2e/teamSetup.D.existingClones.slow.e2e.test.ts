import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';

import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { repoRootDir } from '../../src/testkit/paths';

const run = createRunDirs({ runLabel: 'core' });
const testDir = run.testDir(`team-existing-clones-${randomUUID()}`);
let fixture: TeamSetupFFixture | undefined;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let machineId: string;

beforeAll(async () => {
  fixture = await startTeamSetupFFixture({ testDir });
  const account = await fixture.createAccount('member');
  const enrolled = await fixture.enrollDaemon(account, {
    cliLaunchSpec: { command: process.execPath, args: ['--import',
      resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs'),
      resolve(repoRootDir(), 'apps/cli/src/index.ts')], cwd: repoRootDir() },
    env: { GIT_TRACE2_EVENT: join(testDir, 'git-events.jsonl') },
  });
  machineId = enrolled.target.machineId;
  ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: account.uiCredentials });
  await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
  await fixture.assertKnownGoodSessionControl(account, enrolled);
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => ui?.close(), () => fixture?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Existing-clone fixture cleanup failed');
});

async function action(id: string, input: unknown, confirmed = false) {
  if (!ui) throw new Error('UI Action client not started');
  return (confirmed ? ui.executeConfirmed : ui.execute)(id as Parameters<typeof ui.execute>[0], input,
    { surface: 'ui', authority: 'present_user', serverId: ui.serverId, actionCaller: { kind: 'host' } });
}

it('TS.D.existingClones finds only immediate-child origin matches and opens a dirty clone unchanged', async () => {
  const folder = join(testDir, 'selected-folder');
  const matching = join(folder, 'member-work');
  const unrelated = join(folder, 'unrelated');
  const malformed = join(folder, 'malformed-origin');
  const noOrigin = join(folder, 'no-origin');
  const nested = join(folder, 'nested', 'too-deep');
  for (const [directory, origin] of [
    [matching, 'git@github.com:happier-dev/onboarding.git'],
    [unrelated, 'https://github.com/elsewhere/unrelated.git'],
    [malformed, 'not a valid remote'],
    [nested, 'https://github.com/happier-dev/onboarding.git'],
  ]) {
    await mkdir(directory!, { recursive: true });
    execFileSync('git', ['init', '--quiet', directory!]);
    execFileSync('git', ['-C', directory!, 'config', 'remote.origin.url', origin!]);
  }
  await mkdir(noOrigin, { recursive: true });
  execFileSync('git', ['init', '--quiet', noOrigin]);
  const sentinel = Buffer.from([0, 255, 13, 10, 7, 128]);
  await writeFile(join(matching, 'unfinished.bin'), sentinel);
  const configBefore = await readFile(join(matching, '.git', 'config'));
  const tracePath = join(testDir, 'git-events.jsonl');
  const traceBefore = await readFile(tracePath, 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  });
  const discovery = await action('scm.repository.discover', {
    machineId, cwd: folder,
    repositories: [{ kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/onboarding' }],
  });
  expect(discovery).toMatchObject({ ok: true, result: { success: true,
    matches: [{ rootPath: matching, repositoryIdentity: {
      kind: 'github', deployment: 'https://github.com', repository: 'happier-dev/onboarding',
    } }] } });
  if (!discovery.ok) throw new Error(`Discovery refused: ${discovery.errorCode}`);
  const { ScmRepositoryDiscoverResponseSchema } = await import('@happier-dev/protocol/scm/repositoryDiscovery');
  const found = ScmRepositoryDiscoverResponseSchema.parse(discovery.result);
  if (!found.success || !found.matches[0]) throw new Error('Matching clone was not discovered');
  expect(found.skipped).toEqual([{ rootPath: malformed, origin: { success: true, kind: 'invalid' } }]);
  const choices = await import('../../../../apps/ui/sources/components/projects/activation/projectOpenChoices');
  const choice = choices.selectProjectOpenDiscoveredClone(choices.projectOpenChoiceStateFromDraft({
    serverId: ui!.serverId, machineId,
  }, [], null), found.matches[0]);
  const selection = choices.buildProjectOpenDraft(choice);
  const openInput = choices.buildProjectOpenInput(selection, []);
  expect(openInput).toMatchObject({ source: { kind: 'folder', path: matching }, materialization: { kind: 'attach' } });
  const gitEvents = (await readFile(tracePath, 'utf8')).slice(traceBefore.length).trim().split('\n')
    .map(line => JSON.parse(line) as { event: string; argv?: string[] });
  const origins = gitEvents.filter(event => event.event === 'start'
    && event.argv?.join(' ').includes('config --local --get remote.origin.url'));
  expect(origins).toHaveLength(4);
  const unavailable = await action('scm.repository.discover', { machineId,
    cwd: join(folder, 'moved-folder'), repositories: [] });
  expect(unavailable).toMatchObject({ ok: true, result: { success: false, errorCode: 'ENOENT', error: expect.any(String) } });
  const opened = await action('projects.open', openInput, true);
  expect(opened).toMatchObject({ ok: true, result: { kind: 'opened', directory: matching,
    workspace: { machineId, rootPath: matching } } });
  if (!opened.ok) throw new Error(`Clone attach refused: ${opened.errorCode}`);
  const project = OpenProjectResultV1Schema.parse(opened.result);
  if (project.kind !== 'opened') throw new Error(`Clone was not opened: ${project.kind}`);
  const [{ openTeamSetupFirstTask }, { createFrontDoorActionExecute }, { getActiveServerAccountScope },
    { readNewSessionDraftProjectionFromRepository }, { createNewSessionComposerDocumentOwner },
    { prepareLocalSessionDraftScope }] = await Promise.all([
    import('../../../../apps/ui/sources/components/teams/setup/teamSetupPlan'),
    import('../../../../apps/ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor'),
    import('../../../../apps/ui/sources/sync/domains/scope/activeServerAccountScope'),
    import('../../../../apps/ui/sources/components/sessions/composer/newSessionDraftRepositoryAdapter'),
    import('../../../../apps/ui/sources/components/sessions/composer/newSessionComposerDocumentOwner'),
    import('../../../../apps/ui/sources/sync/ops/sessionDrafts/sessionDraftRepository'),
  ]);
  const scope = getActiveServerAccountScope();
  if (!scope) throw new Error('Member Account scope unavailable');
  await prepareLocalSessionDraftScope(scope);
  let draftId: string | undefined;
  const executeAction = createFrontDoorActionExecute(undefined, { sessionAuthoringPresentation: {
    navigateToNewSession: input => { draftId = input.draftId; },
  } });
  const authored = await openTeamSetupFirstTask({ executeAction, project, machineId,
    prompt: 'Review my unfinished clone before proposing a change.', context: {
      surface: 'ui', authority: 'present_user', serverId: ui!.serverId,
      expectedAccountId: scope.accountId, actionCaller: { kind: 'host' },
    } });
  expect(authored.ok).toBe(true);
  if (!draftId) throw new Error('Editable first-task composer did not open');
  expect(readNewSessionDraftProjectionFromRepository({ scope, draftId })?.draft).toMatchObject({
    input: 'Review my unfinished clone before proposing a change.', selectedMachineId: machineId, selectedPath: matching,
  });
  const composer = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', draftId } });
  composer.apply(composer.read().revision, { text: 'My edited clone task', references: [], attachments: [] });
  expect(readNewSessionDraftProjectionFromRepository({ scope, draftId })?.draft.input).toBe('My edited clone task');
  expect(await readFile(join(matching, 'unfinished.bin'))).toEqual(sentinel);
  expect(await readFile(join(matching, '.git', 'config'))).toEqual(configBefore);
});
