import { expect } from 'vitest';
import { WorkflowEventsListOutputV1Schema } from '@happier-dev/protocol/actions/specs/workflowEvents';
import { PluginEventAutomationSetupResultV1Schema } from '@happier-dev/protocol/automations/automationEventSetupResultV1';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { MachineResourcesPolicyGetResultV1Schema, MachineResourcesPolicyMutationResultV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import type { TeamSetupFFixture } from './teamSetupF';
import type { AutomationEventFilterV1 } from '@happier-dev/protocol/automations/automationEventFilterV1';
import { fetchJson } from './http';
import { waitFor } from './timing';

type Account = Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
type Machine = Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;

export async function attachMachineEventTrigger(fixture: TeamSetupFFixture, actor: Account, machine: Machine,
  eventId: string, filter: AutomationEventFilterV1 | null = null) {
  const catalogResult = await actor.execute('workflow.events.list', machine.target);
  if (!catalogResult.ok) throw new Error(`${eventId} catalog refused (${catalogResult.errorCode})`);
  const selected = WorkflowEventsListOutputV1Schema.parse(catalogResult.result).events.find(row =>
    row.event.identity.pluginId === 'happier.machine.services' && row.event.identity.localId === eventId);
  expect(selected, `The ${eventId} event must be selectable through the ordinary Event catalog`).toBeDefined();
  if (!selected?.observationBinding) throw new Error(`${eventId} source has no exact watcher assignment`);
  const targetContext = { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } } as const;
  const setup = await actor.execute('action.invoke', { action: selected.setupAction.identity,
    expectedContributorOccurrenceId: selected.setupAction.occurrenceId, input: { v: 1, ...machine.target } },
  { ...targetContext, presentUserConfirmation: { actionId: 'action.invoke' } });
  if (!setup.ok) throw new Error(`${eventId} source setup refused (${setup.errorCode})`);
  const source = PluginEventAutomationSetupResultV1Schema.parse(setup.result);
  const linked = await actor.executeReviewed('workflow.trigger.add', {
    target: { kind: 'inline', definition: { version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      blocks: [{ kind: 'step', id: 'review', document: { text: `Review this settled ${eventId} fact.`,
        references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
    } },
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'pluginEvent', enabled: true, eventRef: selected.event.identity,
      sourceInstanceId: source.sourceInstanceId, sourceContractVersion: source.sourceContractVersion,
      sourceConfig: source.sourceConfig, displayLabel: source.displayLabel,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: selected.observationBinding.materializationRef },
      filter, maximumObservationAgeMs: null },
  });
  if (!linked.ok) {
    throw new Error(`${eventId} trigger refused (${JSON.stringify({ errorCode: linked.errorCode,
      failureCause: linked.failureCause })})`);
  }
  const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
  await waitFor(async () => {
    const listed = await actor.execute('workflow.trigger.list', { automationId: saved.set.automationId, triggerId: saved.triggerId });
    if (!listed.ok) throw new Error(`${eventId} source read refused (${listed.errorCode})`);
    const trigger = WorkflowTriggerListResultV1Schema.parse(listed.result).sets.flatMap(set => set.triggers)
      .find(row => row.id === saved.triggerId);
    return trigger?.kind === 'pluginEvent' && trigger.sourceStatus?.state === 'observing';
  }, { context: `${eventId} source observes before its native effect` });
  const readRuns = async () => {
    const response = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, {
      headers: { Authorization: `Bearer ${actor.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
    });
    expect(response.status).toBe(200);
    return AutomationV3RunListResponseSchema.parse(response.data).runs;
  };
  expect(await readRuns()).toEqual([]);
  return { saved, selected, readRuns };
}

/** Real policy Action → native idle-stop settlement → ordinary observed Run.
 * The minute is the Guard's minimum configured idle deadline, not a test clock. */
export async function assertGuardStopLifecycle(fixture: TeamSetupFFixture, actor: Account, machine: Machine) {
  const guarded = await fixture.assertKnownGoodSessionControl(actor, machine);
  const { saved, selected, readRuns } = await attachMachineEventTrigger(fixture, actor, machine, 'guard-stopped',
    { v: 1, all: [{ field: '/sessionId', op: 'eq', value: guarded.sessionId }] });
  const before = await actor.execute('machines.resources.policy.get', machine.target);
  if (!before.ok) throw new Error(`Guard policy read refused (${before.errorCode})`);
  const policy = MachineResourcesPolicyGetResultV1Schema.parse(before.result);
  if (policy.status !== 'ready') throw new Error(`Guard policy unavailable (${policy.status})`);
  const idleAfterMs = 60_000;
  const changed = await actor.execute('machines.resources.policy.set', { ...machine.target,
    expectedRevision: policy.revision, patch: { guard: { idleSessions: { enabled: true, afterMs: idleAfterMs, warnBeforeMs: 0 } } } },
  { presentUserConfirmation: { actionId: 'machines.resources.policy.set' } });
  if (!changed.ok) throw new Error(`Guard policy write refused (${changed.errorCode})`);
  expect(MachineResourcesPolicyMutationResultV1Schema.parse(changed.result).status).toBe('applied');
  try {
    await waitFor(async () => {
      const runs = await readRuns();
      expect(runs.length).toBeLessThanOrEqual(1);
      return runs.length === 1 && typeof runs[0]!.producedSessionId === 'string';
    }, { timeoutMs: idleAfterMs + 30_000, intervalMs: 500, failFast: true,
      context: 'Native idle-stop settlement starts exactly one ordinary Run' });
    const runs = await readRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cause).toMatchObject({ kind: 'trigger', triggerId: saved.triggerId,
      triggerKind: 'pluginEvent', evidence: { eventRef: selected.event.identity } });
    expect(JSON.stringify(runs[0]!.cause)).not.toMatch(/stdout|stderr|accessToken|refreshToken/);
    const metadata = await actor.readSessionMetadata(guarded.sessionId);
    expect(metadata.sessionGuardStateV1).toMatchObject({ kind: 'stopped', rule: 'idle_sessions' });
  } finally {
    const current = await actor.execute('machines.resources.policy.get', machine.target);
    if (!current.ok) throw new Error(`Guard policy recovery refused (${current.errorCode})`);
    const observed = MachineResourcesPolicyGetResultV1Schema.parse(current.result);
    if (observed.status !== 'ready') throw new Error(`Guard policy recovery unavailable (${observed.status})`);
    const restored = await actor.execute('machines.resources.policy.set', { ...machine.target,
      expectedRevision: observed.revision, patch: { guard: { idleSessions: policy.policy.guard.idleSessions } } },
    { presentUserConfirmation: { actionId: 'machines.resources.policy.set' } });
    expect(restored).toMatchObject({ ok: true, result: { status: 'applied' } });
  }
}
