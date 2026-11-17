import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { MachineSetupPlanResultV1Schema, machineSetupApplyTargetFromPlanV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupApplyResultV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupOperationV1';
import { ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { actionOperationStore } from '../../../../apps/ui/sources/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors } from '../../../../apps/ui/sources/sync/domains/actionOperations/actionOperationSelectors';
import { machineTerminalInput, machineTerminalStreamRead } from '../../../../apps/ui/sources/sync/ops/machineTerminal';

import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { startGithubCliBoundary } from '../../src/testkit/githubCliBoundary';

const run = createRunDirs({ runLabel: 'team-setup-e' });
const testDir = run.testDir(`machine-cli-${randomUUID()}`);
let fixture: TeamSetupFFixture | undefined;
let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
let machineId: string;
let credentials: Parameters<typeof connectUiActionClient>[0]['credentials'];
let githubBoundary: Awaited<ReturnType<typeof startGithubCliBoundary>> | undefined;

beforeAll(async () => {
  fixture = await startTeamSetupFFixture({ testDir });
  const account = await fixture.createAccount('member');
  credentials = account.uiCredentials;
  const nativeConfig = join(testDir, 'gh-config');
  const nativeHome = join(testDir, 'native-home');
  const nativeGitGlobal = join(testDir, 'git-global');
  const nativeGitSystem = join(testDir, 'git-system');
  await Promise.all([mkdir(nativeConfig, { recursive: true }), mkdir(nativeHome, { recursive: true }),
    writeFile(nativeGitGlobal, ''), writeFile(nativeGitSystem, '')]);
  githubBoundary = await startGithubCliBoundary();
  const enrolled = await fixture.enrollDaemon(account, { env: { ...githubBoundary.env, NODE_OPTIONS: `${fixture.sourceOptions} ${githubBoundary.env.NODE_OPTIONS}`, GH_CONFIG_DIR: nativeConfig,
    HOME: nativeHome, USERPROFILE: nativeHome, GIT_CONFIG_GLOBAL: nativeGitGlobal, GIT_CONFIG_SYSTEM: nativeGitSystem,
    // Exercise gh's browser handoff without opening a developer browser.
    BROWSER: 'true',
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
  } });
  machineId = enrolled.target.machineId;
});

// Each test connects after the shared UI device reset has run.
beforeEach(async () => {
  ui = await connectUiActionClient({ serverUrl: fixture!.server.baseUrl, credentials });
  await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machineId), { timeoutMs: 60_000 });
  // P04: prove the existing route across this client, Home and daemon before
  // treating an unknown plugin CLI as feature RED.
  expect(await ui.execute('machines.agents.signIn.status', { machineId, agentId: 'claude' }, {
    surface: 'ui', authority: 'present_user', serverId: ui.serverId, actionCaller: { kind: 'host' },
  })).toMatchObject({ ok: true });
});

afterEach(async () => { await ui?.close(); ui = undefined; });

afterAll(async () => {
  const failures: unknown[] = [];
  for (const close of [() => ui?.close(), () => fixture?.stop(), () => githubBoundary?.stop()]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Machine CLI fixture cleanup failed');
});

// This native subcase deliberately uses the installed gh, an empty private config
// directory and the real requester Action route; it never imitates gh with a shim.
it('TS.E.nativeGh reads a plugin-declared machine CLI through the existing sign-in Action', async () => {
  if (!ui) throw new Error('UI Action client not started');
  const result = await ui.execute('machines.agents.signIn.status', {
    machineId, agentId: 'happier.scm.forge.github/gh',
  }, { surface: 'ui', authority: 'present_user', serverId: ui.serverId, actionCaller: { kind: 'host' } });
  expect(result).toMatchObject({ ok: true, result: {
    status: 'signedOut', nativeLogin: 'login_terminal',
    connectedServices: [expect.objectContaining({ serviceId: expect.any(String) })],
  } });
});

it('TS.E.nativeGh keeps real device output in the requester terminal and cancels the acquired process', async () => {
  if (!ui || !githubBoundary) throw new Error('Native GitHub fixture not started');
  const context = { surface: 'ui' as const, authority: 'present_user' as const,
    serverId: ui.serverId, actionCaller: { kind: 'host' as const } };
  const agentId = 'happier.scm.forge.github/gh';
  const opened = await ui.executeConfirmed('machines.agents.signIn.start', {
    machineId, agentId, method: 'native', launchId: 'device_code',
  }, context);
  expect(opened, opened.ok ? undefined : opened.errorCode)
    .toMatchObject({ ok: true, result: { terminalId: expect.any(String) } });
  if (!opened.ok || !opened.result || typeof opened.result !== 'object'
    || !('terminalId' in opened.result) || typeof opened.result.terminalId !== 'string')
    throw new Error('Native device terminal was not acquired');
  const terminalId = opened.result.terminalId;
  let cursor = 0;
  let output = '';
  let lastOutputAt = 0;
  const readPrivateOutput = async () => {
    const response = await machineTerminalStreamRead(machineId, { terminalId, cursor }, { serverId: context.serverId });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.errorCode);
    cursor = response.nextCursor;
    const bytes = response.events.filter(event => event.t === 'data').map(event => event.data).join('');
    if (bytes) lastOutputAt = Date.now();
    output += bytes;
    // This headless Action client substitutes the terminal renderer boundary.
    // gh's native survey prompt asks the renderer for its cursor position.
    const cursorQueries = bytes.match(/\u001b\[6n/g) ?? [];
    for (let query = 0; query < cursorQueries.length; query++) {
      expect(await machineTerminalInput(machineId, { terminalId, data: '\u001b[24;80R' }, { serverId: context.serverId }))
        .toMatchObject({ ok: true });
    }
    return response;
  };
  try {
    await waitFor(async () => {
      await readPrivateOutput();
      // The installed gh 2.102 survey consumes cursor replies before answer
      // input. Its captured native fixture settles the prompt during this idle.
      return output.includes('Authenticate Git with your GitHub credentials?') && Date.now() - lastOutputAt >= 1_000;
    }, { timeoutMs: 60_000 });
    expect(await machineTerminalInput(machineId, { terminalId, data: 'y\r' }, { serverId: context.serverId }))
      .toMatchObject({ ok: true });
    await waitFor(async () => {
      await readPrivateOutput();
      return output.includes(githubBoundary!.deviceCode) && output.includes(githubBoundary!.verificationURI);
    }, { timeoutMs: 60_000 });
    expect(output).not.toContain('constructed-device-attempt');
  } finally {
    expect(await ui.execute('machines.agents.signIn.cancel', { machineId, agentId, terminalId }, context))
      .toMatchObject({ ok: true, result: { ok: true } });
  }
  await waitFor(async () => (await readPrivateOutput()).done, { timeoutMs: 60_000 });
  expect(await ui.execute('machines.agents.signIn.status', { machineId, agentId }, context))
    .toMatchObject({ ok: true, result: { status: 'signedOut' } });
});

it('TS.E.machineRows and TS.E.ambient retain ordered script rows through native execution and operation pushes', async () => {
  if (!ui) throw new Error('UI Action client not started');
  const context = { surface: 'ui' as const, authority: 'present_user' as const,
    serverId: ui.serverId, actionCaller: { kind: 'host' as const } };
  const target = { homeId: ui.serverId, machineId };
  const planned = await ui.execute('machines.setup.plan', { ...target, mode: 'effects', sources: [{
    kind: 'direct', setup: { scripts: [{ body: 'printf FIRST', affects: 'none' }, { body: 'printf SECOND', affects: 'none' }] },
  }] }, context);
  expect(planned).toMatchObject({ ok: true });
  if (!planned.ok) throw new Error('Machine rows Plan failed');
  const plan = MachineSetupPlanResultV1Schema.parse(planned.result);
  const applied = await ui.executeConfirmed('machines.setup.apply', { ...target,
    targets: [machineSetupApplyTargetFromPlanV1(target, plan)],
  }, context);
  expect(applied).toMatchObject({ ok: true });
  if (!applied.ok) throw new Error('Machine rows Apply failed');
  const receipt = MachineSetupApplyResultV1Schema.parse(applied.result);
  const completed = await ui.execute('action.operations.get', {
    serverId: ui.serverId, machineId, operationId: receipt.operationId, waitForTerminal: true,
  }, context);
  expect(completed).toMatchObject({ ok: true });
  if (!completed.ok) throw new Error('Machine rows observation failed');
  const found = ActionOperationGetV1ResponseSchema.parse(completed.result);
  expect(found).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
  // Apply owns the combined Run. The admitted native child publishes its own
  // rows; the Setup tab follows that child through the same retained Run cause.
  expect(receipt.runId).toEqual(expect.any(String));
  const listed = await ui.execute('action.operations.list', { serverId: ui.serverId, machineId }, context);
  expect(listed).toMatchObject({ ok: true });
  if (!listed.ok) throw new Error('Machine rows child list failed');
  const native = ActionOperationListV1ResponseSchema.parse(listed.result).items.find(operation =>
    operation.originRunId === receipt.runId && operation.domainRef?.kind === 'machineSetup');
  expect(native).toBeDefined();
  if (!native) throw new Error('Combined Setup native child was not retained');
  const child = await ui.execute('action.operations.get', {
    serverId: ui.serverId, machineId, operationId: native.operationId, waitForTerminal: true,
  }, context);
  expect(child).toMatchObject({ ok: true });
  if (!child.ok) throw new Error('Machine rows child observation failed');
  expect(ActionOperationGetV1ResponseSchema.parse(child.result)).toMatchObject({ kind: 'found', operation: { state: 'succeeded', domainRef: {
    kind: 'machineSetup', steps: [{ state: 'succeeded' }, { state: 'succeeded' }],
  } } });
  await waitFor(() => [...actionOperationStore.getSnapshot().operationsByKey.values()].some(entry =>
    entry.snapshot.operationId === native.operationId && entry.snapshot.originRunId === receipt.runId
      && entry.snapshot.state === 'succeeded' && entry.snapshot.domainRef?.kind === 'machineSetup'
      && entry.snapshot.domainRef.steps?.every(step => step.state === 'succeeded')), { timeoutMs: 60_000 });
  expect(actionOperationSelectors.selectActivitySummary(actionOperationStore.getSnapshot()))
    .toMatchObject({ activeCount: 0, hasAttention: true });
});
