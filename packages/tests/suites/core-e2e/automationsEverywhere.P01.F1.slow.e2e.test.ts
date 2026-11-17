import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { startAutomationsEverywhereDeploymentFixture, prepareAutomationsEverywhereDeployment } from '../../src/testkit/automationsEverywhereDeployment';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { healthResultProjectionPageSchema } from '../../../plugins/machine-services/src/healthResultProjection';
import { HEALTH_RESULTS_ACTION_ID } from '../../../plugins/machine-services/src/actionIds';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { readWorkflowChildSession } from '../../src/testkit/workflowChildSession';

let setup: Awaited<ReturnType<typeof startAutomationsEverywhereDeploymentFixture>> | undefined;
let endpoint: ReturnType<typeof createServer> | undefined;
afterEach(async () => { await setup?.fixture.stop(); setup = undefined;
  if (endpoint) await new Promise<void>((resolve, reject) => endpoint!.close(error => error ? reject(error) : resolve()));
  endpoint = undefined;
}, 0);

it('P01.F1 health failure opens diagnose Session', async () => {
  const healthy = new Map([['/first', true], ['/second', true], ['/foreign', true]]);
  endpoint = createServer((request, response) => { response.statusCode = healthy.get(request.url ?? '') === false ? 503 : 200; response.end(); });
  await new Promise<void>(resolve => endpoint!.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address();
  if (!address || typeof address === 'string') throw new Error('External health endpoint unavailable');
  const testDir = await mkdtemp(join(tmpdir(), 'automations-p01-f1-'));
  setup = await startAutomationsEverywhereDeploymentFixture(testDir);
  const { fixture, actor, machine, deployInput } = setup;
  await fixture.assertKnownGoodSessionControl(actor, machine);
  type Actor = typeof actor;
  type Machine = typeof machine;
  const catalog = await actor.execute('workflow.events.list', machine.target);
  expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
  if (!catalog.ok) throw new Error(catalog.errorCode);
  const event = WorkflowEventsListOutputV1Schema.parse(catalog.result).events.find(row =>
    row.event.identity.pluginId === HEALTH_CHECK_EVENT_REFS_V1.failed.pluginId
      && row.event.identity.localId === HEALTH_CHECK_EVENT_REFS_V1.failed.localId);
  if (!event?.observationBinding) throw new Error('Saved health observer unavailable');
  const bindings = new Map([[machine.target.machineId, event.observationBinding.materializationRef]]);
  const observationTransport = (observer: Machine) => {
    const watcherMaterializationRef = bindings.get(observer.target.machineId);
    if (!watcherMaterializationRef) throw Error('Observer materialization is unavailable');
    return { kind: 'checkpointedPull' as const, watcherMaterializationRef };
  };
  const registerObserver = async (owner: Actor, observer: Machine) => {
    const catalog = await owner.execute('workflow.events.list', observer.target);
    expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
    if (!catalog.ok) throw Error(catalog.errorCode);
    const selected = WorkflowEventsListOutputV1Schema.parse(catalog.result).events.find(row =>
      row.event.identity.pluginId === HEALTH_CHECK_EVENT_REFS_V1.failed.pluginId && row.event.identity.localId === HEALTH_CHECK_EVENT_REFS_V1.failed.localId);
    if (!selected?.observationBinding) throw Error('Saved health observer unavailable');
    bindings.set(observer.target.machineId, selected.observationBinding.materializationRef);
  };
  const invokeResult = async (localId: string, input: unknown, owner = actor, observer = machine) => {
    const output = await owner.execute('action.invoke', { action: { pluginId: event.event.identity.pluginId, localId }, input },
      { presentUserConfirmation: { actionId: 'action.invoke' }, externalActionTarget: { kind: 'machine',
        machineId: observer.target.machineId, project: { machineId: observer.target.machineId, directory: observer.workspaceDir } } });
    expect(output.ok, JSON.stringify(output)).toBe(true);
    if (!output.ok) throw new Error(output.errorCode);
    return output.result;
  };
  const invoke = async (localId: string, input: unknown, owner = actor, observer = machine) =>
    PluginEventAutomationSetupResultV1Schema.parse(await invokeResult(localId, input, owner, observer));
  const saved = await invoke('health/setup', { v: 1, subject: { kind: 'environment', environmentId: deployInput.environmentId },
    checks: [{ checkId: 'external', kind: { pluginId: event.event.identity.pluginId, localId: 'http' },
      binding: { kind: 'healthCheck' }, config: { endpoint: `http://127.0.0.1:${address.port}/first`, expectStatus: 200 },
      periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 },
    { checkId: 'other', kind: { pluginId: event.event.identity.pluginId, localId: 'http' },
      binding: { kind: 'healthCheck' }, config: { endpoint: `http://127.0.0.1:${address.port}/other`, expectStatus: 200 },
      periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] });
  const transport = observationTransport(machine);
  const enrolled = await actor.executeAsPerson('workflow.trigger.add', { observationOnly: { kind: 'observationOnly' },
    trigger: { kind: 'pluginEvent', enabled: true, eventRef: HEALTH_CHECK_EVENT_REFS_V1.status,
      sourceInstanceId: saved.sourceInstanceId, sourceContractVersion: saved.sourceContractVersion,
      sourceConfig: saved.sourceConfig, displayLabel: saved.displayLabel,
      observationTransport: transport, filter: null, maximumObservationAgeMs: null } });
  expect(enrolled.ok, JSON.stringify(enrolled)).toBe(true);
  // This subscribes to committed saved transitions, independently of their probe
  // configuration. An omitted subject must not become a specific probe selector.
  const selection = await invoke('health-check-failed/setup', { v: 1, serverId: fixture.serverId });
  const addListener = async (owner = actor, observer = machine, selected = selection, subject?: AutomationSubjectV1) => {
    const trigger = await owner.executeAsPerson('workflow.trigger.add', {
    target: { kind: 'inline', definition: { version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'diagnose', document: { text: 'Diagnose the saved health failure.', references: [], attachments: [] },
        input: [], result: { kind: 'text' } }] } },
    project: { machineId: observer.target.machineId, directory: observer.workspaceDir },
    trigger: { kind: 'pluginEvent', enabled: true, eventRef: event.event.identity,
      sourceInstanceId: selected.sourceInstanceId, sourceContractVersion: selected.sourceContractVersion,
      sourceConfig: selected.sourceConfig, displayLabel: selected.displayLabel, ...(subject ? { subject } : {}),
      observationTransport: observationTransport(observer),
      filter: null, maximumObservationAgeMs: null },
  });
  expect(trigger.ok, JSON.stringify(trigger)).toBe(true);
  if (!trigger.ok) throw new Error(trigger.errorCode);
    return WorkflowTriggerWriteResultV1Schema.parse(trigger.result);
  };
  const linked = await addListener();
  const exact = await addListener(actor, machine, selection,
    { kind: 'healthCheck', serverId: fixture.serverId, sourceInstanceId: saved.sourceInstanceId, checkId: 'external' });
  const runs = async (link = linked, owner = actor) => {
    const response = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${encodeURIComponent(link.set.automationId)}/runs`, {
      headers: { Authorization: `Bearer ${owner.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
    expect(response.status).toBe(200);
    return AutomationV3RunListResponseSchema.parse(response.data).runs;
  };
  const diagnosisSessionIds = new Map<string, string>();
  const hasDiagnosisSession = async (runId: string, owner = actor) => {
    if (diagnosisSessionIds.has(runId)) return true;
    const session = await readWorkflowChildSession({ execute: owner.execute,
      serverBaseUrl: fixture.server.baseUrl, token: owner.credentials.token, runId, blockId: 'diagnose' });
    if (!session) return false;
    diagnosisSessionIds.set(runId, session.id);
    return true;
  };
  const addSavedSource = async (owner: Actor, observer: Machine, label: string, path: string) => {
    const invokeOwner = async (actionId: ActionId, input: unknown) => {
      const output = await owner.executeAsPerson(actionId, input, {
        externalActionTarget: { kind: 'machine', machineId: observer.target.machineId },
        presentUserConfirmation: { actionId },
      });
      expect(output.ok, JSON.stringify(output)).toBe(true);
      if (!output.ok) throw Error(output.errorCode);
      return output.result;
    };
    const created = ProjectSourcesReadOutputV1Schema.parse(await invokeOwner('projects.sources.create', {
      serverId: fixture.serverId, name: label, requestKey: randomUUID(),
    }));
    if (!created.ok) throw Error(created.error);
    const environment = await prepareAutomationsEverywhereDeployment({ serverId: fixture.serverId, projectSourceId: created.source.id,
      name: label, machine: observer, docker: setup!.docker, invoke: invokeOwner });
    const source = await invoke('health/setup', { v: 1, subject: { kind: 'environment', environmentId: environment.environmentId },
      checks: [{ checkId: 'external', kind: { pluginId: event.event.identity.pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
        config: { endpoint: `http://127.0.0.1:${address.port}${path}`, expectStatus: 200 }, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] }, owner, observer);
    const enrolled = await owner.executeAsPerson('workflow.trigger.add', { observationOnly: { kind: 'observationOnly' },
      trigger: { kind: 'pluginEvent', enabled: true, eventRef: HEALTH_CHECK_EVENT_REFS_V1.status,
        sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion, sourceConfig: source.sourceConfig,
        displayLabel: source.displayLabel, observationTransport: observationTransport(observer), filter: null, maximumObservationAgeMs: null } });
    expect(enrolled.ok, JSON.stringify(enrolled)).toBe(true);
    return source;
  };
  const daemonEnvironment = { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', PATH: `${join(testDir, 'tools')}${delimiter}${process.env.PATH ?? ''}` };
  // The fixture's name chooses a distinct local home; credentials still belong
  // to the same Account, so this is a real cross-Machine saved transition.
  const secondMachine = await fixture.enrollDaemon({ ...actor, name: 'deployer-second-machine' }, { env: daemonEnvironment });
  await registerObserver(actor, secondMachine);
  const second = await addSavedSource(actor, secondMachine, 'Second saved resource', '/second');
  const foreign = await fixture.createAccount('foreign');
  const foreignMachine = await fixture.enrollDaemon(foreign, { env: daemonEnvironment });
  await registerObserver(foreign, foreignMachine);
  const foreignSource = await addSavedSource(foreign, foreignMachine, 'Private foreign resource', '/foreign');
  const foreignSelection = await invoke('health-check-failed/setup', { v: 1, serverId: fixture.serverId }, foreign, foreignMachine);
  const foreignLinked = await addListener(foreign, foreignMachine, foreignSelection);
  const retainedCheck = async (sourceInstanceId: string, status: 'up' | 'down', after = 0, owner = actor, observer = machine) => {
    let cursor: string | undefined;
    do {
      const page = healthResultProjectionPageSchema.parse(await invokeResult(HEALTH_RESULTS_ACTION_ID, cursor ? { cursor } : {}, owner, observer));
      if (page.items.some(item => item.source?.sourceInstanceId === sourceInstanceId
        && item.projection.checks.some(check => check.checkId === 'external' && check.result.status === status && check.result.observedAt > after))) return true;
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  };
  expect(await runs()).toEqual([]);
  await waitFor(() => retainedCheck(second.sourceInstanceId, 'up'), { context: 'Second resource probe is saved before its failure' });
  healthy.set('/first', false);
  await waitFor(async () => { const current = await runs(); expect(current.length).toBeLessThanOrEqual(1);
    return current.length === 1 && await hasDiagnosisSession(current[0]!.id);
  }, { failFast: true, context: 'One saved transition starts the ordinary cause-bound diagnosis Session' });
  expect((await runs())[0]!.cause).toMatchObject({ kind: 'trigger', triggerKind: 'pluginEvent',
    triggerId: linked.triggerId, evidence: { eventRef: HEALTH_CHECK_EVENT_REFS_V1.failed } });
  await waitFor(async () => (await runs(exact)).length === 1, { context: 'Exact saved-check subject matches its failure' });
  const firstFailure = Date.now();
  await waitFor(() => retainedCheck(saved.sourceInstanceId, 'down', firstFailure), { context: 'Repeated failed probe remains the same transition' });
  expect(await runs()).toHaveLength(1);
  expect(await runs(exact)).toHaveLength(1);
  expect(await runs(foreignLinked, foreign)).toEqual([]);
  healthy.set('/first', true);
  await waitFor(() => retainedCheck(saved.sourceInstanceId, 'up'), { context: 'Recovery is retained without replaying the failure' });
  healthy.set('/second', false);
  await waitFor(async () => { const current = await runs();
    return current.length === 2 && (await Promise.all(current.map(run => hasDiagnosisSession(run.id)))).every(Boolean);
  }, { failFast: true, context: 'Omitted subject also matches the second saved resource' });
  expect(await runs(exact)).toHaveLength(1);
  expect(await runs(foreignLinked, foreign)).toEqual([]);
  healthy.set('/foreign', false);
  await waitFor(async () => { const current = await runs(foreignLinked, foreign);
    return current.length === 1 && await hasDiagnosisSession(current[0]!.id, foreign);
  }, { failFast: true, context: 'Foreign saved health failure stays within its Account' });
  expect(await runs()).toHaveLength(2);
  expect(await runs(exact)).toHaveLength(1);
  expect(new Set(diagnosisSessionIds.values()).size).toBe(3);
  expect(await retainedCheck(foreignSource.sourceInstanceId, 'down', 0, foreign, foreignMachine)).toBe(true);
}, 0);
