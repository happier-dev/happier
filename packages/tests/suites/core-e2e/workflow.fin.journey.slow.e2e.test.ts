import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { HomeRetentionDryRunResultV1Schema } from '@happier-dev/protocol/home/governance';
import { WorkflowDefinitionCreateResultV1Schema, WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListResultV1Schema, WorkflowRunGetResultV1Schema,
  WorkflowRunListResultV1Schema, WorkflowRunStartResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { resolveSessionAgentPickerSelectionFields } from '../../../../apps/ui/sources/components/sessions/agentPicker/sessionAgentPickerSelectionFields';
import { listAutomationDefinitionRuns } from '../../../../apps/ui/sources/sync/api/automations/apiAutomationRuns';
import { getAutomationDefinition, getAutomationRunDetail } from '../../../../apps/ui/sources/sync/api/automations/apiAutomations';
import { buildWorkflowDefinitionCandidate, buildWorkflowEditorDraftFromDefinition } from '../../../../apps/ui/sources/sync/domains/workflows/workflowAuthoring';
import { createWorkflowEditorDraft } from '../../../../apps/ui/sources/sync/domains/workflows/workflowEditorDraft';
import { createWorkflowRunListRowRoute, readWorkflowRunTarget } from '../../../../apps/ui/sources/sync/domains/workflows/workflowRunRoute';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { waitFor } from '../../src/testkit/timing';
import { createRunDirs } from '../../src/testkit/runDir';

// Every mutation enters the same UI Action executor used by a present person.
// The fixture owns its SQLite database and daemon; shared QA is never used.
describe('FIN saved Workflow journeys through UI Actions and a real daemon', () => {
  const run = createRunDirs({ runLabel: 'fin-command-journeys' });
  let fixture: FinJourneyFixture | undefined;
  let ui: Awaited<ReturnType<typeof connectUiPersonActionClient>> | undefined;
  let account: Awaited<ReturnType<FinJourneyFixture['createAccount']>>;
  let machine: Awaited<ReturnType<FinJourneyFixture['enrollDaemon']>>;
  beforeEach(async () => {
    fixture = await startFinJourneyFixture({ testDir: run.testDir(randomUUID()),
      serverEnv: { ...process.env,
        HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    account = await fixture.createAccount('FIN author');
    await fixture.claimHomeOwner(account);
    machine = await fixture.enrollDaemon(account, { env: { ...process.env,
      HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    ui = await connectUiPersonActionClient({ serverUrl: fixture!.actionServerApiUrl,
      accountSecret: account.auth.accountSigningSeed });
    // enrollDaemon already waits for the daemon owner's control-ready signal.
    await waitFor(() => ui!.isAccountReady() && ui!.isMachineActive(machine.target.machineId),
      { context: 'FIN mounted UI observes the enrolled daemon' });
  });
  afterEach(async () => {
    try { await ui?.close(); }
    finally { ui = undefined; await fixture?.stop(); fixture = undefined; }
  });

  async function act(actionId: ActionId, input: unknown, scope: 'machine-project' | 'account' = 'machine-project') {
    if (!ui || !fixture) throw new Error('FIN Action client did not start');
    const result = await ui.executeConfirmed(actionId, input, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: ui.serverId, serverIdentityId: fixture.serverId, actionRequestId: randomUUID(),
      ...(scope === 'machine-project' ? {
        externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
          project: { machineId: machine.target.machineId, directory: machine.workspaceDir } },
      } : {}),
    });
    expect(result.ok, `${actionId}: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
    return result.result;
  }
  const command = (text: string) => ({ version: 1, blocks: [
    { kind: 'action', id: 'command', actionId: 'machines.command.run',
      input: { command: { kind: 'literal', value: text } } },
  ] });
  async function save(title: string, text: string) {
    return WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.create', {
      definitionId: randomUUID(), metadata: { title }, definition: command(text),
    }));
  }

  it('J2 saves a blank draft with the selected Agent and no native mode, then reopens and edits it', async () => {
    const title = 'Agent default mode';
    const blank = createWorkflowEditorDraft({ draftId: randomUUID(), name: title });
    const [step] = blank.blocks;
    if (step?.kind !== 'step') throw new Error('The blank draft did not open with an Agent step');
    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
    const modelId = 'claude-sonnet-4-6';
    const fields = resolveSessionAgentPickerSelectionFields({ agentTarget, updatedAt: Date.now(),
      selection: { modelId, sessionModeId: '', configOverrides: {} } });
    const text = 'Answer with the current project name.';
    const draft = { ...blank, blocks: [{ ...step, document: { ...step.document, text }, execution: { agentTarget, ...fields } }] };
    const saved = WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.create', {
      definitionId: randomUUID(), metadata: { title }, definition: buildWorkflowDefinitionCandidate(draft),
    }));

    const library = WorkflowDefinitionListResultV1Schema.parse(await act('workflow.definition.list', {}));
    const row = library.definitions.find(entry => entry.metadata?.title === title);
    expect(row?.definitionId).toBe(saved.definitionId);
    if (!row) throw new Error('The saved Workflow is missing from the Library');
    const opened = WorkflowDefinitionGetResultV1Schema.parse(await act('workflow.definition.get', { definitionId: row.definitionId }));
    expect(opened.definition.blocks).toMatchObject([{ kind: 'step', document: { text }, execution: {
      agentTarget, modelSelection: { ref: { modelId } }, acpSessionModeId: null,
    } }]);

    const renamed = buildWorkflowEditorDraftFromDefinition({ draftId: randomUUID(), name: `${title} edited`, definition: opened.definition });
    const updated = WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.update', {
      definitionId: row.definitionId, expectedRevision: opened.revision,
      metadata: { title: renamed.name }, definition: buildWorkflowDefinitionCandidate(renamed),
    }));
    const reopened = WorkflowDefinitionGetResultV1Schema.parse(await act('workflow.definition.get', { definitionId: row.definitionId }));
    expect(reopened).toMatchObject({ definitionId: saved.definitionId, revision: updated.revision,
      metadata: { title: renamed.name }, definition: opened.definition });
    expect(reopened.revision).not.toEqual(opened.revision);
  });

  it('J4 retains a missed occurrence while the Machine is offline and opens that exact History row', async () => {
    if (!ui || !fixture) throw new Error('FIN Action client did not start');
    const { actionServerApiUrl } = fixture;
    const { serverId } = ui;
    const requestContext = { serverId, request: (path: string, init?: RequestInit) => fetch(new URL(path, actionServerApiUrl), init) };
    const saved = await save('Offline schedule', 'echo FIN-J4');
    const scheduledAt = Date.now() + 60_000;
    const trigger = WorkflowTriggerWriteResultV1Schema.parse(await act('workflow.trigger.add', {
      workflow: saved.definitionId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'once', scheduledAt } },
    }));
    const { triggerId, set: { automationId } } = trigger;
    expect(trigger.set).toMatchObject({ enabled: true, triggers: [{ id: triggerId, enabled: true, nextRunAt: scheduledAt }] });
    if (!triggerId) throw new Error('Save did not return the schedule trigger identity');
    await machine.daemon.stop();
    await waitFor(() => ui!.isMachineActive(machine.target.machineId) === false, { context: 'the Home reports the Machine offline' });

    let history: ReturnType<typeof WorkflowRunListResultV1Schema.parse> | undefined;
    try {
      await waitFor(async () => {
        history = WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', { triggerId }, 'account'));
        return history.runs.length > 0;
      }, { context: 'the real scheduler retains the offline occurrence', intervalMs: 1_000, timeoutMs: 130_000, failFast: true });
    } catch (cause) {
      const [definition, occurrences] = await Promise.all([
        getAutomationDefinition(account.uiCredentials, automationId, requestContext),
        listAutomationDefinitionRuns({ automationId, credentials: account.uiCredentials, requestContext }),
      ]);
      const schedule = definition.triggers.find(row => row.id === triggerId);
      throw new Error(`Trigger History did not return a row: ${JSON.stringify({
        enabled: definition.enabled, schedule: schedule?.kind === 'schedule' ? schedule.nextRunAt : schedule?.kind,
        occurrences: occurrences.runs.map(({ id, state, errorCode }) => ({ id, state, errorCode })),
      })}`, { cause });
    }
    if (!history) throw new Error('Trigger History was not read');
    expect(history.runs.map(row => row.state)).toEqual(['missed']);
    const [row] = history.runs;
    if (!row) throw new Error('The missed History row is unavailable');
    const route = new URL(createWorkflowRunListRowRoute({ id: row.id, summary: row, automation: null }, serverId), actionServerApiUrl);
    expect(route.searchParams.get('serverId')).toBe(serverId);
    const target = readWorkflowRunTarget({ ...Object.fromEntries(route.searchParams), runId: decodeURIComponent(route.pathname.split('/').at(-1)!) });
    expect(target).toEqual({ kind: 'occurrence', automationId: trigger.set.automationId, runId: row.id });
    if (target?.kind !== 'occurrence') throw new Error('History did not open the occurrence reader');

    const detail = await getAutomationRunDetail(account.uiCredentials, target.automationId, target.runId, requestContext);
    expect(detail).toMatchObject({ id: row.id, automationId: trigger.set.automationId, triggerId: trigger.triggerId,
      state: 'missed', dueAt: scheduledAt, startedAt: null, producedSessionId: null, errorCode: 'machine_offline' });
  });

  it('J3 Save a command → Start as the person → open its accepted content', async () => {
    const saved = await save('Fresh command', 'echo FIN-start');
    const started = WorkflowRunStartResultV1Schema.parse(await act('workflow.run.start', {
      runId: randomUUID(), source: { kind: 'saved', definitionId: saved.definitionId, revision: saved.revision },
      executionTarget: { kind: 'session' },
    }));
    const opened = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId: started.run.id }));
    expect(opened.authoredDefinition).toEqual(saved.definition);
    expect(opened.run.machineId).toBe(machine.target.machineId);
    const history = WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', { sourceArtifactId: saved.definitionId }));
    expect(history.runs.map(run => run.id)).toContain(started.run.id);
  });

  it('J1 retention: schedule → run → remove the trigger → reopen History and definition', async () => {
    // Retention is independent of command approval. A read-only Action still
    // traverses the real Workflow executor and produces a completed Run.
    const saved = WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.create', {
      definitionId: randomUUID(), metadata: { title: 'Retained Machine read' },
      definition: { version: 1, blocks: [{ kind: 'action', id: 'read-machine', actionId: 'machines.list', input: {} }] },
    }));
    const trigger = WorkflowTriggerWriteResultV1Schema.parse(await act('workflow.trigger.add', {
      workflow: saved.definitionId, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'schedule', enabled: true,
        schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
    }));
    await act('workflow.trigger.run_now', { automationId: trigger.set.automationId });
    let runId: string | undefined;
    await waitFor(async () => {
      const history = WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', { automationId: trigger.set.automationId }));
      runId = history.runs[0]?.id;
      return runId !== undefined;
    }, { context: 'FIN scheduled Run appears in History' });
    if (!runId) throw new Error('Scheduled Run missing');
    expect(await act('workflow.run.wait', { runId, conditions: ['terminal'] }))
      .toMatchObject({ observation: 'terminal', run: { state: 'succeeded' } });
    const before = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId }));
    await act('workflow.trigger.remove', { automationId: trigger.set.automationId, triggerId: trigger.triggerId });
    // 3a517717 fixed sweep selection, not the DELETE response. Exercise the
    // real retention owner before reading History so the old exception is seen.
    const retention = HomeRetentionDryRunResultV1Schema.parse(await act('home.retention.dryRun', {}));
    expect(retention.byDomain.automationRuns).toMatchObject({ wouldDelete: 0 });
    const history = WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', { automationId: trigger.set.automationId }));
    expect(history.runs.map(run => run.id)).toContain(runId);
    const after = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId }));
    expect(after.authoredDefinition).toEqual(before.authoredDefinition);
    expect(after.run.origin).toEqual(before.run.origin);
    expect(WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.get', {
      definitionId: saved.definitionId,
    })).definition).toEqual(saved.definition);
  });

  it('J1 edit → re-run keeps each History entry bound to its accepted version', async () => {
    const saved = await save('Editable command', 'echo FIN-before-edit');
    const start = async (revision: typeof saved.revision) => WorkflowRunStartResultV1Schema.parse(
      await act('workflow.run.start', { runId: randomUUID(), executionTarget: { kind: 'session' },
        source: { kind: 'saved', definitionId: saved.definitionId, revision } }));
    const first = await start(saved.revision);
    const updated = WorkflowDefinitionCreateResultV1Schema.parse(await act('workflow.definition.update', {
      definitionId: saved.definitionId, expectedRevision: saved.revision,
      metadata: { title: 'Edited command' }, definition: command('echo FIN-after-edit'),
    }));
    const second = await start(updated.revision);
    expect(second.run.id).not.toBe(first.run.id);
    const firstHistory = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId: first.run.id }));
    const secondHistory = WorkflowRunGetResultV1Schema.parse(await act('workflow.run.get', { runId: second.run.id }));
    expect(firstHistory.authoredDefinition).toEqual(saved.definition);
    expect(secondHistory.authoredDefinition).toEqual(updated.definition);
    expect(secondHistory.authoredDefinition).not.toEqual(firstHistory.authoredDefinition);
    const history = WorkflowRunListResultV1Schema.parse(await act('workflow.run.list', { sourceArtifactId: saved.definitionId }));
    expect(history.runs.map(run => run.id)).toEqual(expect.arrayContaining([first.run.id, second.run.id]));
  });
});
