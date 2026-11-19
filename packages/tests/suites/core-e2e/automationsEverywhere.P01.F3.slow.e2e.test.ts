import { afterEach, expect, it } from 'vitest';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { AutomationV3RunListResponseSchema, DeploymentReceiptListResultV1Schema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { startAutomationsEverywhereDeploymentFixture } from '../../src/testkit/automationsEverywhereDeployment';
import { fetchJson } from '../../src/testkit/http';
import { readWorkflowChildSession, waitForWorkflowChildSession } from '../../src/testkit/workflowChildSession';
import { createRunDirs } from '../../src/testkit/runDir';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

let setup: Awaited<ReturnType<typeof startAutomationsEverywhereDeploymentFixture>> | undefined;
afterEach(async () => { await setup?.fixture.stop(); setup = undefined; }, 0);

it('P01.F3 remote resource event reaches ordinary effects', async () => {
  const run = createRunDirs({ runLabel: 'automations-p01-f3' });
  setup = await startAutomationsEverywhereDeploymentFixture(run.testDir('remote-resource'),
    { observeAutomationWriteFailures: true });
  const { fixture, actor, machine, deployInput, docker, projectSourceId } = setup;
  const observer = await fixture.enrollDaemon({ ...actor, name: 'remote-event-observer' },
    { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  const catalog = await actor.execute('workflow.events.list', observer.target);
  expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
  if (!catalog.ok) throw new Error(catalog.errorCode);
  const event = WorkflowEventsListOutputV1Schema.parse(catalog.result).events.find(row =>
    row.event.identity.pluginId === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId
      && row.event.identity.localId === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.localId);
  if (!event?.observationBinding) throw new Error('Remote receipt observer unavailable');
  const configured = await actor.execute('action.invoke', { action: event.setupAction.identity,
    expectedContributorOccurrenceId: event.setupAction.occurrenceId,
    input: { v: 1, serverId: fixture.serverId } },
  { presentUserConfirmation: { actionId: 'action.invoke' }, externalActionTarget: {
    kind: 'machine', machineId: observer.target.machineId,
    project: { machineId: observer.target.machineId, directory: observer.workspaceDir } } });
  expect(configured.ok, JSON.stringify(configured)).toBe(true);
  if (!configured.ok) throw new Error(configured.errorCode);
  const source = PluginEventAutomationSetupResultV1Schema.parse(configured.result);
  const linked = await actor.executeAsPerson('workflow.trigger.add', {
    target: { kind: 'inline', definition: { version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'diagnose', document: { text: 'Diagnose the failed remote deployment.', references: [], attachments: [] },
        input: [], result: { kind: 'text' } }] } },
    project: { machineId: observer.target.machineId, directory: observer.workspaceDir },
    trigger: { kind: 'pluginEvent', enabled: true, eventRef: event.event.identity,
      subject: { kind: 'environment', serverId: fixture.serverId, environmentId: deployInput.environmentId },
      sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion,
      sourceConfig: source.sourceConfig, displayLabel: source.displayLabel,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: event.observationBinding.materializationRef },
      filter: null, maximumObservationAgeMs: null },
  });
  if (!linked.ok) {
    // Native validation prose is intentionally absent from the Action's closed
    // error union. Retain fixed reasons and schema paths, never raw HTTP content.
    const knownReasons = new Map([
      ['Automation Event watcher is not current', 'event_watcher_not_current'],
      ["Automation Event watcher must use the Event's declaring plugin", 'event_watcher_plugin_mismatch'],
      ['Automation Event declaration does not support the selected transport', 'event_transport_unsupported'],
      ['Automation Event declaration does not support the selected subject kind', 'event_subject_kind_unsupported'],
      ['Automation workflow recipe is invalid', 'workflow_recipe_invalid'],
      ['Automation workflow recipe does not match the Account', 'workflow_recipe_account_mismatch'],
      ['Automation execution recipe version must match the next template version', 'workflow_recipe_version_mismatch'],
      ['A workflow trigger set requires exactly one machine assignment', 'workflow_machine_assignment_invalid'],
      ['Workflow trigger scope session is unavailable', 'workflow_scope_session_unavailable'],
    ]);
    const httpFailures = fixture.requestProxy?.entries().filter(request => request.method === 'POST'
      && request.path === '/v3/automations' && request.statusCode !== null && request.statusCode >= 400)
      .map(request => {
        const body = request.responseBody;
        let parsed: unknown = null;
        if (body?.complete && !body.truncated) {
          try { parsed = JSON.parse(body.text); } catch { /* Non-JSON failure has only HTTP evidence. */ }
        }
        const record = parsed !== null && typeof parsed === 'object' ? parsed : {};
        const error = 'error' in record && typeof record.error === 'string' ? record.error : '';
        const code = 'code' in record && typeof record.code === 'string' ? record.code : error;
        const message = 'message' in record && typeof record.message === 'string' ? record.message : error;
        return { method: request.method, path: request.path, statusCode: request.statusCode,
          code: /^[A-Za-z0-9_.:-]+$/.test(code) ? code : null,
          reason: knownReasons.get(error) ?? null,
          validationPath: /^([A-Za-z0-9_.]+):/.exec(error)?.[1]
            ?? /^((?:body|querystring|params)(?:\/[A-Za-z0-9_]+)*)(?:\s|:)/.exec(message)?.[1] ?? null,
          responseComplete: body?.complete === true && !body.truncated };
      });
    expect(linked.ok, JSON.stringify({ linked, httpFailures })).toBe(true);
  }
  if (!linked.ok) throw new Error(linked.errorCode);
  const trigger = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
  const runs = async () => {
    const response = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${encodeURIComponent(trigger.set.automationId)}/runs`, {
      headers: { Authorization: `Bearer ${actor.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
    expect(response.status).toBe(200);
    return AutomationV3RunListResponseSchema.parse(response.data).runs;
  };
  expect(await runs()).toEqual([]);
  await docker.setActivationCommandFailure(true);
  const deployed = await actor.executeReviewed(DEPLOYMENT_DEPLOY_ACTION_ID_V1, deployInput,
    { presentUserConfirmation: { actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1 } });
  const deploymentOutcome = deployed.ok ? { ok: true } : { ok: false, errorCode: deployed.errorCode,
    ...(deployed.failureCause ? { failureCause: deployed.failureCause } : {}) };
  let observedRuns: Awaited<ReturnType<typeof runs>> = [];
  try {
    await waitForWorkflowChildSession(async () => { const current = await runs(); observedRuns = current;
      expect(current.length).toBeLessThanOrEqual(1);
      if (current.length !== 1) return false;
      return await readWorkflowChildSession({ execute: actor.execute, serverBaseUrl: fixture.server.baseUrl,
        token: actor.credentials.token, runId: current[0]!.id, blockId: 'diagnose' }) !== null;
    }, 'The second Machine receipt reaches one ordinary Run and diagnosis Session');
  } catch (cause) {
    const runStates = observedRuns.map(({ id, state, workflowRunState, attempt, errorCode,
      executionDispatchState, producedSessionId }) => ({ id, state, workflowRunState, attempt, errorCode,
      executionDispatchState, producedSessionId }));
    const receiptRead = await actor.execute('deployments.receipts.list', {
      serverId: fixture.serverId, environmentId: deployInput.environmentId,
    });
    const receiptPage = receiptRead.ok ? DeploymentReceiptListResultV1Schema.safeParse(receiptRead.result) : null;
    const receipts = receiptPage?.success && receiptPage.data.ok
      ? receiptPage.data.items.filter(row => row.environmentId === deployInput.environmentId)
        .map(({ id, state, revision, settledAtMs }) => ({ id, state, revision, settledAtMs }))
      : { errorCode: receiptRead.ok ? 'invalid_receipt_page' : receiptRead.errorCode };
    const triggerRead = await actor.execute('workflow.trigger.list', {
      subject: { kind: 'environment', serverId: fixture.serverId, environmentId: deployInput.environmentId },
    });
    const triggerPage = triggerRead.ok ? WorkflowTriggerListResultV1Schema.safeParse(triggerRead.result) : null;
    const sourceStatuses = triggerPage?.success ? triggerPage.data.attached?.filter(row => row.triggerId === trigger.triggerId)
      .map(({ sourceStatus, sourceCatalogStatus }) => ({ sourceStatus, sourceCatalogStatus }))
      : { errorCode: triggerRead.ok ? 'invalid_trigger_page' : triggerRead.errorCode };
    const invocations = await Promise.all(observedRuns.map(async run => {
      try {
        const listed = await actor.execute('workflow.run.invocations.list', { runId: run.id, includeContent: true });
        if (!listed.ok) return { runId: run.id, errorCode: listed.errorCode };
        const page = WorkflowInvocationListResultV1Schema.parse(listed.result);
        return { runId: run.id, nextCursor: page.nextCursor, rows: page.invocationDetails?.map(({ index, progress }) => ({
          id: index.id, lifecycle: index.lifecycle, blockId: progress.invocationPath.blockId,
          blockKind: progress.blockKind, reasonCode: progress.reason?.code,
          execution: progress.execution && { kind: progress.execution.kind,
            ...('sessionId' in progress.execution ? { sessionId: progress.execution.sessionId } : {}) },
        })) };
      } catch (error) {
        return { runId: run.id, diagnosticError: error instanceof Error ? error.name : 'unknown' };
      }
    }));
    throw new Error(`F3 receipt/Run/child did not settle; deployAction=${JSON.stringify(deploymentOutcome)}; observedRuns=${JSON.stringify(runStates)}; receipts=${JSON.stringify(receipts)}; sourceStatuses=${JSON.stringify(sourceStatuses)}; invocations=${JSON.stringify(invocations)}`, { cause });
  }
  expect((await runs())[0]!.cause).toMatchObject({ kind: 'trigger', triggerKind: 'pluginEvent',
    triggerId: trigger.triggerId, evidence: { eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed } });
  const listed = await actor.execute('deployments.receipts.list', {
    serverId: fixture.serverId, environmentId: deployInput.environmentId,
  });
  expect(listed.ok, listed.ok ? undefined : listed.errorCode).toBe(true);
  if (!listed.ok) throw new Error(listed.errorCode);
  const page = DeploymentReceiptListResultV1Schema.parse(listed.result);
  expect(page.ok, page.ok ? undefined : page.error).toBe(true);
  if (!page.ok) throw new Error(page.error);
  const receipt = page.items.find(item => item.environmentId === deployInput.environmentId && item.state === 'failed');
  expect(receipt).toBeDefined();
  expect((await runs())[0]!.cause).toMatchObject({ evidence: { subjectContexts: expect.arrayContaining([
    { role: 'operand', subject: { kind: 'environment', serverId: fixture.serverId, environmentId: deployInput.environmentId } },
    { role: 'context', subject: { kind: 'app', serverId: fixture.serverId, projectSourceId } },
    { role: 'context', subject: { kind: 'machine', serverId: fixture.serverId, machineId: machine.target.machineId } },
  ]) } });
}, 0);
