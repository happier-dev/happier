import { access, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowRunGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_PROMOTE_ACTION_ID_V1, DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN, ScmWorktreeCreateResponseSchema } from '@happier-dev/protocol/scm/worktrees';
import { MachineStorageItemsListResultV1Schema, PileReviewV1Schema, PileApplyResultV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { readDaemonDiagnostics } from '../../src/testkit/daemon/daemon';
import { execGit, initGitRepo } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { assertAcceptedTurnStartLifecycle } from '../../src/testkit/automationsEverywhereTurnStarted';
import { assertGuardStopLifecycle } from '../../src/testkit/automationsEverywhereGuardStop';
import { assertCredentialAttentionLifecycle } from '../../src/testkit/automationsEverywhereCredentialAttention';
import { assertSetupSettlement } from '../../src/testkit/automationsEverywhereSetupSettlement';

let fixture: TeamSetupFFixture | undefined;
afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

it('P01.F6 settled producer fact survives notification fan-out', async () => {
  fixture = await startTeamSetupFFixture({
    testDir: await mkdtemp(join(tmpdir(), 'automations-p01-f6-')),
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1' },
  });
  const actor = await fixture.createAccount('producer-owner');
  const machine = await fixture.enrollDaemon(actor, {
    env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' },
  });
  // Establish the real executor → PostgreSQL Home → daemon path before the
  // assertion about missing producer declarations, so setup is never the RED.
  await fixture.assertKnownGoodMachineControl(actor, machine);
  const result = await actor.execute('workflow.events.list', machine.target);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`Event catalog refused (${result.errorCode})`);
  const catalog = WorkflowEventsListOutputV1Schema.parse(result.result).events;
  expect(catalog.find(({ event }) => event.identity.pluginId === 'happier.machine.services'
    && event.identity.localId === 'deployment-failed')?.event.automation)
    .toMatchObject({ completesActionIds: expect.arrayContaining([DEPLOYMENT_DEPLOY_ACTION_ID_V1]) });
  for (const [localId, actionId] of [['rollback-completed', DEPLOYMENT_ROLLBACK_ACTION_ID_V1],
    ['promotion-completed', DEPLOYMENT_PROMOTE_ACTION_ID_V1]] as const) {
    expect(catalog.find(({ event }) => event.identity.pluginId === 'happier.machine.services'
      && event.identity.localId === localId)?.event.automation)
      .toMatchObject({ completesActionIds: [actionId], completionOutcome: 'succeeded' });
  }
  expect(catalog.some(({ event }) => event.identity.pluginId === 'happier.machine.services'
    && event.identity.localId === 'worktree-removed'),
  'The settled removal owner must be selectable through the ordinary Event catalog').toBe(true);
  const removal = catalog.find(row => row.event.identity.pluginId === 'happier.machine.services'
    && row.event.identity.localId === 'worktree-removed');
  expect(removal, 'The settled removal owner must be selectable through the ordinary Event catalog').toBeDefined();
  const selected = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse(removal);
  expect(selected.event.automation).toMatchObject({ completesActionIds: ['scm.worktree.remove'] });
  // Headless authoring consumes the daemon's exact assignment for this source.
  expect(selected.observationBinding?.materializationRef).toMatchObject({
    machineId: machine.target.machineId, pluginId: selected.event.identity.pluginId,
  });
  if (!selected.observationBinding) throw new Error('Removal source has no exact watcher assignment');
  const targetContext = { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } } as const;
  const setup = await actor.execute('action.invoke', { action: selected.setupAction.identity,
    expectedContributorOccurrenceId: selected.setupAction.occurrenceId, input: { v: 1, ...machine.target } },
  { ...targetContext, presentUserConfirmation: { actionId: 'action.invoke' } });
  expect(setup.ok, JSON.stringify(setup)).toBe(true);
  if (!setup.ok) throw new Error(`Removal source setup refused (${setup.errorCode})`);
  const source = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
  const linked = await actor.executeReviewed('workflow.trigger.add', {
    target: { kind: 'inline', definition: { version: 1,
      inputs: [{ name: 'payload', valueType: 'json', required: true }],
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the settled worktree removal.',
        references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
    } },
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'pluginEvent', enabled: true, eventRef: selected.event.identity,
      sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion,
      sourceConfig: source.sourceConfig, displayLabel: source.displayLabel,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: selected.observationBinding.materializationRef },
      filter: null, maximumObservationAgeMs: null },
  });
  expect(linked.ok, JSON.stringify(linked)).toBe(true);
  if (!linked.ok) throw new Error(`Removal trigger refused (${linked.errorCode})`);
  const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
  expect(saved.triggerId, 'A single trigger add returns the committed trigger identity').toBeTypeOf('string');
  const readSelectedTrigger = async () => {
    const listed = await actor.execute('workflow.trigger.list', { automationId: saved.set.automationId, triggerId: saved.triggerId });
    if (!listed.ok) throw new Error(`Removal source read refused (${listed.errorCode})`);
    return WorkflowTriggerListResultV1Schema.parse(listed.result).sets
      .flatMap(set => set.triggers).find(row => row.id === saved.triggerId);
  };
  const readSourceDiagnostic = async () => {
    const trigger = await readSelectedTrigger();
    const status = trigger?.kind === 'pluginEvent' ? trigger.sourceStatus : undefined;
    return { automationId: saved.set.automationId, triggerId: saved.triggerId ?? null,
      triggerFound: trigger !== undefined, triggerKind: trigger?.kind ?? null,
      source: status ? { state: status.state, code: status.code, observedCount: status.observedCount,
        admittedCount: status.admittedCount, skippedCount: status.skippedCount } : null };
  };
  try {
    await waitFor(async () => {
      const trigger = await readSelectedTrigger();
      return trigger?.kind === 'pluginEvent' && trigger.sourceStatus?.state === 'observing';
    }, { context: 'Removal source starts observing before the mutation' });
  } catch (error) {
    console.error('F6_DAEMON_DIAGNOSTIC', JSON.stringify(await readDaemonDiagnostics(machine.daemon)));
    console.error('F6_REMOVAL_SOURCE_DIAGNOSTIC', JSON.stringify(await readSourceDiagnostic()));
    throw error;
  }

  // Git only prepares this fixture's repository. Both worktree mutations use
  // the ordinary Action executor and the enrolled daemon's native backend.
  await initGitRepo({ repoDir: machine.workspaceDir });
  execGit(machine.workspaceDir, ['commit', '--allow-empty', '-m', 'Initial']);
  const created = await actor.execute('scm.worktree.create', { cwd: machine.workspaceDir,
    displayName: 'f6-removal' }, { ...targetContext, presentUserConfirmation: { actionId: 'scm.worktree.create' } });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error(`Worktree creation refused (${created.errorCode})`);
  const checkout = ScmWorktreeCreateResponseSchema.parse(created.result);
  if (!checkout.success) throw new Error(`Native worktree creation failed (${checkout.errorCode})`);
  const checkoutPhysicalRoot = await realpath(checkout.worktreePath);
  const opened = await actor.execute('projects.open', { ...machine.target,
    source: { kind: 'folder', path: checkout.worktreePath }, materialization: { kind: 'attach' } },
  { presentUserConfirmation: { actionId: 'projects.open' } });
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  if (!opened.ok) throw new Error('Created checkout was not accepted');
  const accepted = OpenProjectResultV1Schema.parse(opened.result);
  if (accepted.kind !== 'opened') throw new Error('Created checkout was not accepted');

  const secret = 'F6_PRIVATE_WORKTREE_VALUE_NEVER_IN_EVENT_CAUSE';
  const secretPath = join(checkout.worktreePath, '.private-env');
  await writeFile(secretPath, secret);
  const removalInput = { cwd: machine.workspaceDir, worktreePath: checkout.worktreePath,
    confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN };
  const removalContext = { ...targetContext, presentUserConfirmation: { actionId: 'scm.worktree.remove' } } as const;
  // Confirmed deletion deliberately removes untracked files. An existing
  // directory that Git never registered exercises a genuine native refusal.
  const unregisteredPath = join(machine.workspaceDir, 'f6-unregistered-directory');
  await mkdir(unregisteredPath);
  const rejected = await actor.execute('scm.worktree.remove', { ...removalInput,
    worktreePath: unregisteredPath }, removalContext);
  expect(rejected).toMatchObject({ ok: true, result: { success: false } });
  await expect(access(unregisteredPath)).resolves.toBeUndefined();
  await expect(access(checkout.worktreePath)).resolves.toBeUndefined();
  const readRuns = async () => {
    const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, {
      headers: { Authorization: `Bearer ${actor.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
    });
    expect(response.status).toBe(200);
    return AutomationV3RunListResponseSchema.parse(response.data).runs;
  };
  const readRunPayload = async (runId: string) => {
    const opened = await actor.execute('workflow.run.get', { runId });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) throw new Error(`Removal Run read refused (${opened.errorCode})`);
    return WorkflowRunGetResultV1Schema.parse(opened.result).acceptedContext.inputs.payload;
  };
  expect(await readRuns()).toEqual([]);
  const removed = await actor.execute('scm.worktree.remove', removalInput, removalContext);
  expect(removed, removed.ok ? undefined : JSON.stringify({ errorCode: removed.errorCode,
    failureCause: removed.failureCause })).toMatchObject({ ok: true, result: { success: true } });
  await expect(access(checkout.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
  try {
    await waitFor(async () => {
      const runs = await readRuns();
      expect(runs.length).toBeLessThanOrEqual(1);
      return runs.length === 1 && typeof runs[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'One settled removal starts one Workflow Run' });
  } catch (error) {
    // Keep owner-authored lifecycle facts after disposable worker scratch is
    // reclaimed. Never project the cause payload, private content or headers.
    console.error('F6_DAEMON_DIAGNOSTIC', JSON.stringify(await readDaemonDiagnostics(machine.daemon)));
    const observedRuns = await readRuns();
    console.error('F6_REMOVAL_RUN_DIAGNOSTIC', JSON.stringify({
      runs: observedRuns.map(run => ({ id: run.id, state: run.state, workflowRunState: run.workflowRunState,
        errorCode: run.errorCode, producedSessionId: run.producedSessionId,
        executionDispatchState: run.executionDispatchState })),
      source: await readSourceDiagnostic(),
    }));
    throw error;
  }
  const runs = await readRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.cause).toMatchObject({ kind: 'trigger', triggerId: saved.triggerId,
    triggerKind: 'pluginEvent', evidence: { eventRef: selected.event.identity } });
  // Membership is public routing evidence. The canonical Run reader opens the
  // immutable payload selected by this Workflow's declared input.
  const payload = await readRunPayload(runs[0]!.id);
  expect(payload).toMatchObject({ workspace: accepted.workspace, machineId: machine.target.machineId,
    worktreePath: checkoutPhysicalRoot, outcome: 'removed', removalKind: 'deleted' });
  expect(JSON.stringify(payload)).not.toMatch(/stdout|stderr/);
  expect(JSON.stringify(payload)).not.toContain(secret);
  expect(JSON.stringify(runs[0]!.cause)).not.toContain(secret);
  expect(JSON.stringify(runs[0]!.cause)).not.toContain('stdout');
  expect(JSON.stringify(runs[0]!.cause)).not.toContain('stderr');
  // Storage uses the same settled producer. These checkouts have no accepted
  // Workspace, and retirement moves the root before the observation is read.
  for (const [index, removalKind] of (['deleted', 'retired'] as const).entries()) {
    const create = await actor.execute('scm.worktree.create', { cwd: machine.workspaceDir,
      displayName: `f6-storage-${removalKind}` },
    { ...targetContext, presentUserConfirmation: { actionId: 'scm.worktree.create' } });
    if (!create.ok) throw new Error(`Storage fixture creation refused (${create.errorCode})`);
    const worktree = ScmWorktreeCreateResponseSchema.parse(create.result);
    if (!worktree.success) throw new Error(`Storage fixture creation failed (${worktree.errorCode})`);
    const physicalRoot = await realpath(worktree.worktreePath);
    const inventory = await actor.execute('machines.storage.worktrees.list', machine.target);
    if (!inventory.ok) throw new Error(`Storage inventory refused (${inventory.errorCode})`);
    const item = MachineStorageItemsListResultV1Schema.parse(inventory.result).items
      .find(candidate => candidate.path === worktree.worktreePath);
    if (!item) throw new Error('Created worktree missing from the storage owner inventory');
    const checked = await actor.execute('machines.storage.items.check', { ...machine.target,
      refs: [{ itemId: item.itemId, path: item.path }] });
    if (!checked.ok) throw new Error(`Storage review refused (${checked.errorCode})`);
    const review = PileReviewV1Schema.parse(checked.result);
    expect(review.items).toHaveLength(1);
    const actionId = removalKind === 'retired' ? 'machines.storage.trash.move' : 'machines.storage.deleteNow';
    const applied = await actor.execute(actionId, { ...machine.target, items: review.items.map(row => ({
      ref: row.ref, expect: row.expect,
      ...(removalKind === 'retired' ? { claimedVerdict: row.verdict, reason: row.reason } : {}),
    })) }, { presentUserConfirmation: { actionId } });
    if (!applied.ok) throw new Error(`Storage removal refused (${applied.errorCode})`);
    expect(PileApplyResultV1Schema.parse(applied.result).outcomes)
      .toEqual([{ itemId: item.itemId, status: removalKind === 'retired' ? 'moved' : 'deleted' }]);
    await expect(access(worktree.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const expectedCount = index + 2;
    await waitFor(async () => {
      const observed = await readRuns();
      expect(observed.length).toBeLessThanOrEqual(expectedCount);
      return observed.length === expectedCount && observed.every(run => typeof run.producedSessionId === 'string');
    }, { failFast: true, context: `One unassociated storage ${removalKind} fact retains its original physical root` });
    expect(await readRuns()).toEqual(expect.arrayContaining([expect.objectContaining({ cause: expect.objectContaining({
      kind: 'trigger', triggerId: saved.triggerId, triggerKind: 'pluginEvent',
      evidence: expect.objectContaining({ eventRef: selected.event.identity }),
    }) })]));
    expect(await Promise.all((await readRuns()).map(run => readRunPayload(run.id))))
      .toEqual(expect.arrayContaining([expect.objectContaining({ workspace: null, project: null,
        machineId: machine.target.machineId, worktreePath: physicalRoot, outcome: 'removed', removalKind })]));
  }
  await assertGuardStopLifecycle(fixture, actor, machine);
  await assertCredentialAttentionLifecycle(fixture);
  await assertAcceptedTurnStartLifecycle(fixture, actor, machine);
  await assertSetupSettlement(fixture, actor, machine);
}, 0);
