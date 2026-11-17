import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';

let fixture: TeamSetupFFixture | undefined;
afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

it('P01.F3 server presence admits one ordinary Run without a daemon observer', async () => {
  fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'automations-p01-presence-')),
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  const actor = await fixture.createAccount('presence-owner');
  const producer = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  const executor = await fixture.enrollDaemon({ ...actor, name: 'presence-executor' },
    { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  await fixture.assertKnownGoodSessionControl(actor, executor);
  const catalog = await actor.execute('workflow.events.list', executor.target);
  expect(catalog.ok, JSON.stringify(catalog)).toBe(true);
  if (!catalog.ok) throw new Error(catalog.errorCode);
  const event = WorkflowEventsListOutputV1Schema.parse(catalog.result).events.find(row =>
    row.event.identity.pluginId === 'happier.machine.services' && row.event.identity.localId === 'machine-offline');
  if (!event?.observationBinding) throw new Error('Presence declaration unavailable');
  const configured = await actor.execute('action.invoke', { action: event.setupAction.identity,
    expectedContributorOccurrenceId: event.setupAction.occurrenceId,
    input: { v: 1, serverId: fixture.serverId, machineId: producer.target.machineId } },
  { presentUserConfirmation: { actionId: 'action.invoke' }, externalActionTarget: {
    kind: 'machine', machineId: executor.target.machineId,
    project: { machineId: executor.target.machineId, directory: executor.workspaceDir } } });
  expect(configured.ok, JSON.stringify(configured)).toBe(true);
  if (!configured.ok) throw new Error(configured.errorCode);
  const source = PluginEventAutomationSetupResultV1Schema.parse(configured.result);
  const linked = await actor.executeAsPerson('workflow.trigger.add', {
    target: { kind: 'inline', definition: { version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'diagnose', document: { text: 'Diagnose why the Machine went offline.', references: [], attachments: [] },
        input: [], result: { kind: 'text' } }] } },
    project: { machineId: executor.target.machineId, directory: executor.workspaceDir },
    trigger: { kind: 'pluginEvent', enabled: true, eventRef: event.event.identity,
      sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion,
      sourceConfig: source.sourceConfig, displayLabel: source.displayLabel,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: event.observationBinding.materializationRef },
      filter: null, maximumObservationAgeMs: null },
  });
  expect(linked.ok, JSON.stringify(linked)).toBe(true);
  if (!linked.ok) throw new Error(linked.errorCode);
  const trigger = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
  const runs = async () => {
    const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(trigger.set.automationId)}/runs`, {
      headers: { Authorization: `Bearer ${actor.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
    expect(response.status).toBe(200);
    return AutomationV3RunListResponseSchema.parse(response.data).runs;
  };
  expect(await runs()).toEqual([]);
  await producer.daemon.stop();
  await waitFor(async () => { const current = await runs(); expect(current.length).toBeLessThanOrEqual(1);
    return current.length === 1 && typeof current[0]!.producedSessionId === 'string';
  }, { failFast: true, context: 'The committed server presence transition admits an ordinary diagnosis Run' });
  expect((await runs())[0]!.cause).toMatchObject({ kind: 'trigger', triggerKind: 'pluginEvent',
    triggerId: trigger.triggerId, evidence: { eventRef: event.event.identity } });
}, 0);
