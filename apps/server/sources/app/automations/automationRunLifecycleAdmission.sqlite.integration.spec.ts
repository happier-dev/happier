import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2, AutomationRunCauseSchema,
  deriveAutomationManualOccurrenceKeyV1 } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { admitExecutionRunLifecycleAutomationRunsTx, catchUpAutomationRunLifecycleSourcesTx,
  validateAutomationRunLifecycleSourceTx } from './automationRunLifecycleAdmission';
import { decodeAutomationRunCause, encodeAutomationRunCause } from './automationRunCauseCodec';
import { automationRunCauseSelect } from './automationPersistenceSelect';
import { cancelWorkflowRun } from '@/app/workflows/workflowRunService';
import { applyMachineReplacement, clearMachineReplacement } from '@/app/machines/applyMachineReplacement';

describe('Run lifecycle source admission (retained SQLite owners)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-run-notifications-' }); }, 120_000);
  afterAll(async () => { await harness.close(); });

  async function fixture() {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
    const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
      workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
        inlineDefinition: { version: 1, blocks: [{ kind: 'action', id: 'notice', actionId: 'notifications.notify_me',
          input: { message: { kind: 'literal', value: 'Run finished' } } }] } } } });
    if (recipe.kind !== 'available') throw new Error('recipe unavailable');
    const automation = await db.automation.create({ data: { accountId: account.id, name: 'Notify me', enabled: true,
      templateCiphertext: recipe.serialized, templateVersion: 1 } });
    await db.automationAssignment.create({ data: { automationId: automation.id, machineId: machine.id, enabled: true } });
    return { accountId: account.id, machineId: machine.id, automationId: automation.id };
  }

  it('consumes exact retained execution terminal evidence once and rejects a different machine publisher', async () => {
    const f = await fixture();
    const source = { kind: 'execution_run' as const, machineId: f.machineId, runId: randomUUID() };
    const trigger = await db.automationTrigger.create({ data: { automationId: f.automationId, kind: 'runLifecycle', enabled: true,
      sourceRunId: source.runId, sourceRunMachineId: f.machineId, remainingOccurrences: 1,
      runLifecycleConfigurationJson: JSON.stringify({ kind: 'runLifecycle', source, condition: 'terminal' }) } });
    const occurrence = { v: 1 as const, kind: 'runLifecycle' as const, source, condition: 'terminal' as const,
      sourceRevision: 200, occurredAt: 200 };
    await expect(inTx(tx => admitExecutionRunLifecycleAutomationRunsTx({ tx, ...f, machineId: 'another-machine', occurrence })))
      .rejects.toThrow('source_unavailable');
    await inTx(tx => admitExecutionRunLifecycleAutomationRunsTx({ tx, ...f, occurrence }));
    await inTx(tx => admitExecutionRunLifecycleAutomationRunsTx({ tx, ...f, occurrence }));
    const runs = await db.automationRun.findMany({ where: { automationId: f.automationId }, select: automationRunCauseSelect });
    expect(runs).toHaveLength(1);
    expect(decodeAutomationRunCause(runs[0]!)).toMatchObject({ triggerKind: 'runLifecycle', evidence: { source, sourceRevision: 200 } });
    expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: trigger.id } })).remainingOccurrences).toBe(0);
  });

  it('catches up retained FIN attention using the full predicate and fails closed on lost Account access', async () => {
    const f = await fixture();
    const run = await db.automationRun.create({ data: { accountId: f.accountId, originKind: 'direct',
      causeKind: null, state: 'interrupted', scheduledAt: new Date(), dueAt: new Date(),
      workflowCustodyState: 'pending', workflowAcceptedSnapshotEnvelope: '{}', revision: 4 } });
    const source = { kind: 'workflow_run' as const, runId: run.id };
    const definition = { kind: 'runLifecycle' as const, source, condition: 'needs_attention' as const };
    await inTx(tx => validateAutomationRunLifecycleSourceTx(tx, f.accountId, definition));
    await expect(inTx(tx => validateAutomationRunLifecycleSourceTx(tx, randomUUID(), definition)))
      .rejects.toThrow('source_unavailable');
    await db.automationTrigger.create({ data: { automationId: f.automationId, kind: 'runLifecycle', enabled: true,
      sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify(definition) } });
    await inTx(tx => catchUpAutomationRunLifecycleSourcesTx(tx, f.automationId));
    await inTx(tx => catchUpAutomationRunLifecycleSourcesTx(tx, f.automationId));
    expect(await db.automationRun.count({ where: { automationId: f.automationId } })).toBe(1);
  });

  it('suppresses the originating trigger on its own retained run event before reserving its occurrence', async () => {
    const f = await fixture();
    const run = await db.automationRun.create({ data: { accountId: f.accountId, originKind: 'direct', causeKind: null,
      state: 'succeeded', scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: 'settled',
      workflowAcceptedSnapshotEnvelope: '{}', revision: 4 } });
    const definition = { kind: 'runLifecycle', source: { kind: 'workflow_run', runId: run.id }, condition: 'terminal' };
    const own = await db.automationTrigger.create({ data: { automationId: f.automationId, kind: 'runLifecycle', enabled: true,
      sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify(definition) } });
    const unrelated = await db.automationTrigger.create({ data: { automationId: f.automationId, kind: 'runLifecycle', enabled: true,
      sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify(definition) } });
    // A trigger may be edited after its earlier firing; the Run keeps that earlier immutable cause.
    await db.automationRun.update({ where: { id: run.id }, data: { originKind: 'automation', automationId: f.automationId,
      ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'schedule',
        triggerId: own.id, triggerRevision: 1, occurredAt: 100, evidence: { scheduledFor: 100 },
        occurrenceKey: deriveAutomationManualOccurrenceKeyV1({ automationId: f.automationId, idempotencyKey: run.id }) })) } });
    await inTx(tx => catchUpAutomationRunLifecycleSourcesTx(tx, f.automationId));
    expect(await db.automationRun.count({ where: { triggerId: own.id } })).toBe(1);
    expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: own.id } })).remainingOccurrences).toBe(1);
    expect(await db.automationRun.count({ where: { triggerId: unrelated.id } })).toBe(1);
  });

  it('consumes the actual FIN terminal producer and catches up a later registration, while deletion stays cancelled', async () => {
    const f = await fixture();
    const run = await db.automationRun.create({ data: { accountId: f.accountId, originKind: 'direct', causeKind: null,
      state: 'queued', scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: 'pending',
      workflowAcceptedSnapshotEnvelope: '{}', revision: 0 } });
    await db.automationRunAssignment.create({ data: { runId: run.id, machineId: f.machineId } });
    const definition = { kind: 'runLifecycle' as const, source: { kind: 'workflow_run' as const, runId: run.id }, condition: 'terminal' as const };
    const createSource = () => db.automationTrigger.create({ data: { automationId: f.automationId, kind: 'runLifecycle', enabled: true,
      sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify(definition) } });
    const armed = await createSource();
    const cancelled = await createSource();
    // This represents the persistence boundary left by the canonical remove Action/CRUD.
    await db.automationTrigger.update({ where: { id: cancelled.id }, data: { enabled: false, deletedAt: new Date(),
      sourceRunId: null, runLifecycleConfigurationJson: null, remainingOccurrences: null } });
    await cancelWorkflowRun({ accountId: f.accountId, runId: run.id, expectedRevision: 0 });
    expect(await db.automationRun.count({ where: { triggerId: armed.id } })).toBe(1);
    expect(await db.automationRun.count({ where: { triggerId: cancelled.id } })).toBe(0);
    const late = await createSource();
    await inTx(tx => catchUpAutomationRunLifecycleSourcesTx(tx, f.automationId));
    await inTx(tx => catchUpAutomationRunLifecycleSourcesTx(tx, f.automationId));
    expect(await db.automationRun.count({ where: { triggerId: late.id } })).toBe(1);
  });

  it('observes an actionable FIN hold outside the first invocation page without inventing terminal state', async () => {
    const f = await fixture();
    const run = await db.automationRun.create({ data: { accountId: f.accountId, originKind: 'direct', causeKind: null,
      state: 'running', scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: 'pending',
      workflowAcceptedSnapshotEnvelope: '{}', revision: 6 } });
    await db.workflowRunInvocation.createMany({ data: Array.from({ length: 101 }, (_, ordinal) => ({
      id: randomUUID(), runId: run.id, sequence: BigInt(ordinal), memberOrdinal: BigInt(ordinal),
      lifecycle: ordinal === 100 ? 'needs_attention' as const : 'completed' as const, contentEnvelope: '{}',
    })) });
    const visible = await db.workflowRunInvocation.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' }, take: 100 });
    expect(visible.every(row => row.lifecycle === 'completed')).toBe(true);
    const source = { kind: 'workflow_run' as const, runId: run.id };
    const attention = await db.automationTrigger.create({ data: { automationId: f.automationId, kind: 'runLifecycle', enabled: true,
      sourceRunId: run.id, remainingOccurrences: 1,
      runLifecycleConfigurationJson: JSON.stringify({ kind: 'runLifecycle', source, condition: 'needs_attention' }) } });
    const terminal = await db.automationTrigger.create({ data: { automationId: f.automationId, kind: 'runLifecycle', enabled: true,
      sourceRunId: run.id, remainingOccurrences: 1,
      runLifecycleConfigurationJson: JSON.stringify({ kind: 'runLifecycle', source, condition: 'terminal' }) } });
    await inTx(tx => catchUpAutomationRunLifecycleSourcesTx(tx, f.automationId));
    expect(await db.automationRun.count({ where: { triggerId: attention.id } })).toBe(1);
    expect(await db.automationRun.count({ where: { triggerId: terminal.id } })).toBe(0);
  });

  it('admits a retained FIN terminal source after the actual target Machine replacement is undone', async () => {
    const f = await fixture();
    const replacement = await db.machine.create({ data: { id: randomUUID(), accountId: f.accountId, metadata: '{}' } });
    await inTx(tx => applyMachineReplacement({ tx, accountId: f.accountId, oldMachineId: f.machineId,
      replacementMachineId: replacement.id, reason: 'retained target repair', source: 'manual', actorUserId: f.accountId }));
    const run = await db.automationRun.create({ data: { accountId: f.accountId, originKind: 'direct', causeKind: null,
      state: 'cancelled', scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: 'pending',
      workflowAcceptedSnapshotEnvelope: '{}', revision: 2 } });
    const trigger = await db.automationTrigger.create({ data: { automationId: f.automationId, kind: 'runLifecycle', enabled: true,
      sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify({ kind: 'runLifecycle',
        source: { kind: 'workflow_run', runId: run.id }, condition: 'terminal' }) } });
    await inTx(tx => catchUpAutomationRunLifecycleSourcesTx(tx, f.automationId));
    expect(await db.automationRun.count({ where: { triggerId: trigger.id } })).toBe(0);
    expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: trigger.id } })).remainingOccurrences).toBe(1);
    const recipe = await db.automation.findUniqueOrThrow({ where: { id: f.automationId } });
    const unrelated = await db.automation.create({ data: { accountId: f.accountId, name: 'Other target', enabled: true,
      templateCiphertext: recipe.templateCiphertext, templateVersion: recipe.templateVersion,
      assignments: { create: { machineId: replacement.id, enabled: true } } } });
    const unrelatedTrigger = await db.automationTrigger.create({ data: { automationId: unrelated.id, kind: 'runLifecycle', enabled: true,
      sourceRunId: run.id, remainingOccurrences: 1, runLifecycleConfigurationJson: JSON.stringify({ kind: 'runLifecycle',
        source: { kind: 'workflow_run', runId: run.id }, condition: 'terminal' }) } });
    // The supported Machine undo changes neither the source nor Automation,
    // trigger, assignment or recipe. Its producer must retry this retained fact.
    await inTx(tx => clearMachineReplacement({ tx, accountId: f.accountId, oldMachineId: f.machineId }));
    expect(await db.automationRun.count({ where: { triggerId: trigger.id } })).toBe(1);
    expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: trigger.id } })).remainingOccurrences).toBe(0);
    expect(await db.automationRun.count({ where: { triggerId: unrelatedTrigger.id } })).toBe(0);
    await inTx(tx => clearMachineReplacement({ tx, accountId: f.accountId, oldMachineId: f.machineId }));
    expect(await db.automationRun.count({ where: { triggerId: trigger.id } })).toBe(1);
  });
});
