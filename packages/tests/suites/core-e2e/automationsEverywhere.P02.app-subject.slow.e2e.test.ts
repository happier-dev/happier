import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowRunListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { waitFor } from '../../src/testkit/timing';

describe('Automations everywhere: App Action subjects', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('matches exact and any App triggers for one approved Source update, with replay and another App controls', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'automations-p02-app-subject-'));
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('app-owner');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const context = { defaultSessionId: session.sessionId, externalActionTarget: { kind: 'machine' as const,
      machineId: machine.target.machineId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } };
    const createSource = async (name: string) => {
      const result = await actor.executeAsPerson('projects.sources.create', {
        serverId: fixture!.serverId, name, requestKey: randomUUID(),
      }, context);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      const parsed = ProjectSourcesReadOutputV1Schema.parse(result.result);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.source;
    };
    const source = await createSource('Exact App');
    const other = await createSource('Another App');
    const created = await actor.executeAsPerson('workflow.definition.create', { definitionId: randomUUID(),
      metadata: { title: 'App Action checks' }, definition: { version: 1, blocks: [{ id: 'profiles', kind: 'action',
        actionId: 'actions.policy.get', input: { profiles: { kind: 'literal', value: true } } }] } }, context);
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error(created.errorCode);
    const workflow = WorkflowDefinitionCreateResultV1Schema.parse(created.result);
    const subject = { kind: 'app' as const, serverId: fixture.serverId, projectSourceId: source.id };
    const link = async (exact: boolean) => {
      const result = await actor.executeAsPerson('workflow.trigger.add', { workflow: workflow.definitionId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
        trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: ['projects.sources.update'],
          ...(exact ? { subject } : {}) } }, context);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return WorkflowTriggerWriteResultV1Schema.parse(result.result);
    };
    const exact = await link(true);
    const any = await link(false);
    expect(any.set.automationId).toBe(exact.set.automationId);
    const requestId = randomUUID();
    fixture.takeRequestObservations();
    const requested = await actor.execute('projects.sources.update', {
      serverId: fixture.serverId, sourceId: source.id, expectedRevision: source.revision, patch: { name: 'Updated exact App' },
    }, { ...context, actionRequestId: requestId, authority: 'account_automation',
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { 'projects.sources.update': { approvalRequiredSurfaces: ['cli'] } } }) });
    expect(requested.ok, JSON.stringify(requested)).toBe(true);
    if (!requested.ok) throw new Error(requested.errorCode);
    const pending = ActionApprovalRequestCreatedResultSchema.parse(requested.result);
    expect(fixture.readActionOccurrences()).toEqual([]);
    const decision = await actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: {
      status: 'executed', execution: { ok: true, result: { ok: true, source: { id: source.id, name: 'Updated exact App' } } },
    } });
    const occurrences = fixture.readActionOccurrences().filter(row => row.evidence.requestId === requestId);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.triggers.map(row => row.triggerId).sort()).toEqual([exact.triggerId, any.triggerId].sort());
    const readRuns = async () => {
      const result = await actor.execute('workflow.run.list', { automationId: exact.set.automationId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return WorkflowRunListResultV1Schema.parse(result.result).runs;
    };
    await waitFor(async () => {
      const runs = await readRuns();
      expect(runs.length).toBeLessThanOrEqual(2);
      return runs.length === 2 && runs.every(run => run.state === 'succeeded');
    }, { failFast: true, context: 'Exact and any App checks both complete after the approved update' });
    expect(await actor.replayApprovedApprovalRequest(pending.artifactId)).toMatchObject({ ok: true });
    expect(await readRuns()).toHaveLength(2);
    const otherRequestId = randomUUID();
    fixture.takeRequestObservations();
    const changedOther = await actor.executeAsPerson('projects.sources.update', {
      serverId: fixture.serverId, sourceId: other.id, expectedRevision: other.revision, patch: { name: 'Updated other App' },
    }, { ...context, actionRequestId: otherRequestId });
    expect(changedOther, JSON.stringify(changedOther)).toMatchObject({ ok: true, result: { ok: true } });
    const otherOccurrences = fixture.readActionOccurrences().filter(row => row.evidence.requestId === otherRequestId);
    expect(otherOccurrences).toHaveLength(1);
    expect(otherOccurrences[0]!.triggers.map(row => row.triggerId)).toEqual([any.triggerId]);
    await waitFor(async () => {
      const runs = await readRuns();
      expect(runs.length).toBeLessThanOrEqual(3);
      return runs.length === 3 && runs.every(run => run.state === 'succeeded');
    }, { failFast: true, context: 'Another App starts only the any-App check' });
  }, 0);
});
