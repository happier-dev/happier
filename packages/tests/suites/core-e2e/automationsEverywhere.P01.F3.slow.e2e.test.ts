import { afterEach, expect, it } from 'vitest';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { AutomationV3RunListResponseSchema, DeploymentReceiptListResultV1Schema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { startAutomationsEverywhereDeploymentFixture } from '../../src/testkit/automationsEverywhereDeployment';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { readWorkflowChildSession } from '../../src/testkit/workflowChildSession';
import { createRunDirs } from '../../src/testkit/runDir';

let setup: Awaited<ReturnType<typeof startAutomationsEverywhereDeploymentFixture>> | undefined;
afterEach(async () => { await setup?.fixture.stop(); setup = undefined; }, 0);

it('P01.F3 remote resource event reaches ordinary effects', async () => {
  const run = createRunDirs({ runLabel: 'automations-p01-f3' });
  setup = await startAutomationsEverywhereDeploymentFixture(run.testDir('remote-resource'));
  const { fixture, actor, machine, deployInput, docker } = setup;
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
  expect(linked.ok, JSON.stringify(linked)).toBe(true);
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
  await actor.executeReviewed(DEPLOYMENT_DEPLOY_ACTION_ID_V1, deployInput,
    { presentUserConfirmation: { actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1 } });
  await waitFor(async () => { const current = await runs(); expect(current.length).toBeLessThanOrEqual(1);
    if (current.length !== 1) return false;
    return await readWorkflowChildSession({ execute: actor.execute, serverBaseUrl: fixture.server.baseUrl,
      token: actor.credentials.token, runId: current[0]!.id, blockId: 'diagnose' }) !== null;
  }, { failFast: true, context: 'The second Machine receipt reaches one ordinary Run and diagnosis Session' });
  expect((await runs())[0]!.cause).toMatchObject({ kind: 'trigger', triggerKind: 'pluginEvent',
    triggerId: trigger.triggerId, evidence: { eventRef: DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed } });
  const listed = await actor.execute('deployments.receipts.list', {
    serverId: fixture.serverId, environmentId: deployInput.environmentId,
  });
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  if (!listed.ok) throw new Error(listed.errorCode);
  const page = DeploymentReceiptListResultV1Schema.parse(listed.result);
  expect(page.ok).toBe(true);
  if (!page.ok) throw new Error(page.error);
  const receipt = page.items.find(item => item.environmentId === deployInput.environmentId && item.state === 'failed');
  expect(receipt?.projectSourceId).toEqual(expect.any(String));
  expect((await runs())[0]!.cause).toMatchObject({ evidence: { subjectContexts: expect.arrayContaining([
    { role: 'operand', subject: { kind: 'environment', serverId: fixture.serverId, environmentId: deployInput.environmentId } },
    { role: 'context', subject: { kind: 'app', serverId: fixture.serverId, projectSourceId: receipt!.projectSourceId } },
    { role: 'context', subject: { kind: 'machine', serverId: fixture.serverId, machineId: machine.target.machineId } },
  ]) } });
}, 0);
