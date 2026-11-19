import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ActionSpecGetResultSchema } from '@happier-dev/protocol/actions/specs/catalog';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { AutomationMachineSubjectV1Schema } from '@happier-dev/protocol/automations/automationSubjectV1';
import { readRecordListProperty } from '@happier-dev/protocol/inputs/inputRecords';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { ApprovalExecutionV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchJson } from '../../src/testkit/http';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { connectStdioMcp, parseToolJson } from '../../src/testkit/externalMcp';
import { repoRootDir } from '../../src/testkit/paths';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1, AutomationActionAdmitResultV1Schema } from '../../../protocol/src/automations/automationActionOccurrenceV1';

describe('Automations everywhere: after commit', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('AE.P02.F1-after-commit starts one review Run from the invoking CLI executor', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'automations-p02-f1-'));
    fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('committer');
    const machine = await fixture.enrollDaemon(actor, {
      env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
    });
    const git = (...args: string[]) => execFileSync('git', args,
      { cwd: machine.workspaceDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    // This repository belongs only to the fixture, never the shared checkout.
    git('init');
    git('config', 'user.name', 'Automation fixture');
    git('config', 'user.email', 'automations@example.test');
    await writeFile(join(machine.workspaceDir, 'review.txt'), 'before\n');
    git('add', 'review.txt');
    git('commit', '-m', 'initial');
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const commitActionId = ActionIdSchema.parse('scm.commit.create');
    // C2: authoring consumes the same spec effect declaration as invocation.
    const readActionId = ActionIdSchema.parse('workflow.trigger.list');
    const rejectedRead = await actor.executeAsPerson('workflow.trigger.add', {
      target: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] },
          input: [], result: { kind: 'text' } }],
      } },
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: [readActionId] },
    });
    expect(rejectedRead).toMatchObject({ ok: false, errorCode: 'invalid_input' });
    const linked = await actor.executeAsPerson('workflow.trigger.add', {
      target: { kind: 'inline', definition: { version: 1,
        defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
        blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the latest commit.',
          references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
      } },
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'after', enabled: true, actionIds: [commitActionId] },
    });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(`After-commit trigger refused (${linked.errorCode})`);
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    const rejectedReadUpdate = await actor.executeAsPerson('workflow.trigger.update', {
      automationId: saved.set.automationId, triggerId: saved.triggerId, expectedRevision: saved.set.revision,
      patch: { trigger: { kind: 'action', phase: 'after', actionIds: [readActionId] } },
    });
    expect(rejectedReadUpdate).toMatchObject({ ok: false, errorCode: 'invalid_input' });
    await writeFile(join(machine.workspaceDir, 'review.txt'), 'after\n');
    fixture.takeRequestObservations();
    const commitRequestId = 'after-commit-review-request';
    let commitApprovalArtifactId: string | undefined;
    const committed = await actor.executeWithApproval(commitActionId, { cwd: machine.workspaceDir,
      message: 'feat: review fixture', scope: { kind: 'all-pending' } }, async artifactId => {
      commitApprovalArtifactId = artifactId;
      const read = await actor.execute('approval.request.get', { artifactId });
      expect(read.ok, JSON.stringify(read)).toBe(true);
      if (!read.ok) throw new Error(read.errorCode);
      const { request } = ApprovalRequestGetResultV1Schema.parse(read.result);
      expect(request.executionOriginV1, 'ordinary approval retains its admitted Session Machine')
        .toMatchObject({ machineId: machine.target.machineId });
      const decision = await actor.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' });
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
      return decision;
    }, {
      defaultSessionId: session.sessionId, actionRequestId: commitRequestId,
      authority: 'account_automation', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { [commitActionId]: { approvalRequiredSurfaces: ['cli'] } } }),
    });
    expect(committed, JSON.stringify(committed)).toMatchObject({ ok: true });
    expect(commitApprovalArtifactId, 'the original CLI retains its ordinary Inbox Ask').toBeTypeOf('string');
    if (!commitApprovalArtifactId) throw new Error('The commit did not retain its ordinary approval');
    expect(git('log', '-1', '--format=%s')).toBe('feat: review fixture');
    const occurrence = fixture.readActionOccurrences().find(value => value.evidence.requestId === commitRequestId);
    expect(occurrence, JSON.stringify({ notices: committed.automationNotices,
      requests: fixture.requestProxy?.entries().map(({ method, path, statusCode }) => ({ method, path, statusCode })) }))
      .toBeDefined();
    if (!occurrence) throw new Error('Missing original commit occurrence');
    let latestRunStates: unknown = [];
    let reviewRunId: string | undefined;
    await waitFor(async () => {
      const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, {
        headers: { Authorization: `Bearer ${actor.credentials.token}`,
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
      });
      expect(response.status).toBe(200);
      const runs = AutomationV3RunListResponseSchema.parse(response.data).runs;
      latestRunStates = runs.map(({ id, state, errorCode, producedSessionId }) => ({ id, state, errorCode, producedSessionId }));
      expect(runs.length).toBeLessThanOrEqual(1);
      reviewRunId = runs[0]?.id;
      return runs.length === 1 && runs[0]!.state === 'succeeded';
    }, { failFast: true, context: 'After-commit review Run completes its Agent step' }).catch(error => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; runs=${JSON.stringify(latestRunStates)}; notices=${JSON.stringify(committed.automationNotices)}`);
    });
    if (!reviewRunId) throw new Error('After-commit review Run missing');
    const invocations = await actor.execute('workflow.run.invocations.list', { runId: reviewRunId, includeContent: true });
    expect(invocations.ok, JSON.stringify(invocations)).toBe(true);
    if (!invocations.ok) throw new Error(invocations.errorCode);
    const reviewSteps = WorkflowInvocationListResultV1Schema.parse(invocations.result).invocationDetails
      ?.filter(row => row.progress.blockKind === 'step');
    expect(reviewSteps).toHaveLength(1);
    const execution = reviewSteps?.[0]?.progress.execution;
    if (execution?.kind !== 'session') throw new Error('After-commit review did not run in a Session');
    expect(execution.sessionId).not.toBe(session.sessionId);
    // Managed Workflow Sessions name their Run; the legacy producedSessionId stays null.
    expect(await fetchSessionV2(fixture.server.baseUrl, actor.auth.token, execution.sessionId))
      .toMatchObject({ origin: { kind: 'run_step', runId: reviewRunId } });
    expect(await actor.readSessionMetadata(execution.sessionId)).toMatchObject({
      machineId: machine.target.machineId, path: machine.workspaceDir,
    });
    await fixture.assertSessionAgentOutput(actor, execution.sessionId);

    expect(await actor.replayApprovedApprovalRequest(commitApprovalArtifactId)).toMatchObject({ ok: true });
    expect(fixture.takeRequestObservations().filter(request => request.method === 'POST'
      && request.path === AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1)).toHaveLength(1);
    expect(occurrence, 'the material commit publishes its retained invocation identity').toBeDefined();
    expect(occurrence.evidence).toMatchObject({ actionId: commitActionId, phase: 'after', status: 'succeeded' });
    expect(JSON.stringify(occurrence)).not.toContain('feat: review fixture');
    expect(JSON.stringify(occurrence)).not.toContain(machine.workspaceDir);
    const echo = await fetchJson<unknown>(`${fixture.server.baseUrl}${AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1}`, {
      method: 'POST', headers: { Authorization: `Bearer ${actor.credentials.token}`, 'Content-Type': 'application/json',
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
      body: JSON.stringify(occurrence),
    });
    expect(echo.status).toBe(200);
    expect(AutomationActionAdmitResultV1Schema.parse(echo.data).results).toEqual([
      expect.objectContaining({ kind: 'rejoined', triggerId: saved.triggerId }),
    ]);
    const afterEcho = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, {
      headers: { Authorization: `Bearer ${actor.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
    });
    const retainedRuns = AutomationV3RunListResponseSchema.parse(afterEcho.data).runs;
    expect(retainedRuns).toHaveLength(1);
    expect(retainedRuns[0]?.cause).toMatchObject({ kind: 'trigger', triggerKind: 'action',
      evidence: { actionId: commitActionId, requestId: commitRequestId, phase: 'after' } });
    expect(JSON.stringify(retainedRuns)).not.toContain('feat: review fixture');

    // The UI Action executor and actual MCP tools/call use the same write owner.
    // The agent's dangerous write keeps its ordinary human approval.
    const mcp = await connectStdioMcp({ command: process.execPath,
      args: [resolve(repoRootDir(), 'apps/cli/src/index.ts'), 'mcp', 'serve', '--session', session.sessionId],
      env: { ...process.env, CI: '1', HAPPIER_HOME_DIR: machine.homeDir,
        HAPPIER_SERVER_URL: fixture.server.baseUrl, NODE_OPTIONS: fixture.sourceOptions,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' } });
    try {
      const discovery = await mcp.client.callTool({ name: 'action_spec_get', arguments: { id: commitActionId } });
      expect(discovery.isError).not.toBe(true);
      const discoveredAction = ActionSpecGetResultSchema.parse(parseToolJson(discovery)).actionSpec;
      expect(discoveredAction).toMatchObject({ id: commitActionId, automation: { after: true } });
      // Plan 01's Machine subject read is the ordinary machines.list Action.
      // Only the real Account-authorized inventory supplies the selected id.
      const machines = await mcp.client.callTool({
        name: 'action_execute', arguments: { actionId: 'machines.list', input: { serverId: machine.target.serverId } },
      });
      expect(machines.isError, JSON.stringify(machines)).not.toBe(true);
      const inventory = PUBLIC_ACTION_OUTPUT_SCHEMAS['machines.list'].parse(parseToolJson(machines));
      const selectedMachine = readRecordListProperty(inventory, 'items')
        .find(item => item.machineId === machine.target.machineId);
      expect(selectedMachine, 'The enrolled Machine must be selectable from the permitted inventory').toBeDefined();
      if (!selectedMachine) throw new Error('Enrolled Machine missing from the permitted inventory');
      expect(selectedMachine.serverId).toBe(machine.target.serverId);
      const subject = AutomationMachineSubjectV1Schema.parse({ kind: 'machine',
        serverId: machine.target.serverId, machineId: selectedMachine.machineId });
      const parityInput = {
        target: { kind: 'inline', definition: { version: 1,
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
          blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the latest commit.',
            references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
        } },
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
        trigger: { kind: 'action', phase: 'after', enabled: true,
          actionIds: [ActionIdSchema.parse(discoveredAction.id)], subject },
      };
      const uiAuthored = await actor.executeAsPerson('workflow.trigger.add', parityInput);
      expect(uiAuthored.ok, JSON.stringify(uiAuthored)).toBe(true);
      if (!uiAuthored.ok) throw new Error(`UI authoring refused (${uiAuthored.errorCode})`);
      const uiSet = WorkflowTriggerWriteResultV1Schema.parse(uiAuthored.result).set;
      const submitted = await mcp.client.callTool({
        name: 'action_execute', arguments: { actionId: 'workflow.trigger.add', input: parityInput },
      });
      expect(submitted.isError, JSON.stringify(submitted)).not.toBe(true);
      const requested = ActionApprovalRequestCreatedResultSchema.parse(parseToolJson(submitted));
      const decided = await actor.executeAsPerson('approval.request.decide', {
        artifactId: requested.artifactId, decision: 'approve',
      });
      expect(decided).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
      if (!decided.ok || !decided.result || typeof decided.result !== 'object'
        || !('execution' in decided.result)) throw new Error('MCP authoring did not execute after approval');
      const execution = ApprovalExecutionV2Schema.parse(decided.result.execution);
      if (!execution.ok) throw new Error(`MCP authoring refused (${execution.errorCode})`);
      const mcpSet = WorkflowTriggerWriteResultV1Schema.parse(execution.result).set;
      const matching = (set: typeof uiSet) => set.triggers.map(trigger => {
        if (trigger.kind !== 'action' || !('phase' in trigger)) throw new Error('Action authoring saved another trigger kind');
        return { kind: trigger.kind, phase: trigger.phase, actionIds: trigger.actionIds,
          subject: 'subject' in trigger ? trigger.subject : undefined };
      });
      expect(matching(uiSet)).toEqual([{ kind: 'action', phase: 'after', actionIds: [commitActionId], subject }]);
      expect(matching(mcpSet)).toEqual(matching(uiSet));
    } finally {
      await mcp.client.close();
      await mcp.transport.close();
    }
  }, 0);
});
