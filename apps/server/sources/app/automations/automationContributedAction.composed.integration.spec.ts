import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { parseAutomationRunExecutionRecipeV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAutomation } from './automationCrudService';
import { runAutomationScheduleWorkerPass } from './automationScheduleWorker';
import { claimAutomationRun } from './automationClaimService';
import { cancelAutomationRun, startAutomationRun } from './automationRunService';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-action-schedule-', initAuth: false }); }, 120_000);
afterAll(async () => { await harness?.close(); });

it('schedules and reclaims an Action through the existing queue, preserving frozen input through edits and cancellation', async () => {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const machineId = randomUUID();
    await db.machine.create({ data: { id: machineId, accountId: account.id, installationId: randomUUID(), metadata: '{}' } });
    const action = { pluginId: 'com.example.jobs', localId: 'refresh' };
    const input = AutomationDefinitionCreateRequestSchema.parse({
        automationId: randomUUID(), name: 'Scheduled Action', enabled: true,
        executionRecipe: { v: 1, templateVersion: 1, triggerEvidence: null,
            target: { kind: 'contributedAction', action },
            template: { t: 'plain', v: { v: 1, prompt: '', actionInput: { kind: 'literal', value: { project: 'original' } } } } },
        assignments: [{ machineId }],
        triggers: [{ triggerId: randomUUID(), trigger: { kind: 'schedule', enabled: true,
            schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } } }],
    });
    const automation = await createAutomation({ accountId: account.id, input });
    const now = new Date();
    await db.automationTrigger.updateMany({ where: { automationId: automation.id }, data: { nextRunAt: now } });
    await runAutomationScheduleWorkerPass({ now });
    const first = await claimAutomationRun({ accountId: account.id, machineId, leaseDurationMs: 30_000, scope: 'execution' });
    expect(first.run?.automationId).toBe(automation.id);
    if (!first.run || !first.accountCurrentness) throw new Error('Action Run was not claimable');
    const frozen = parseAutomationRunExecutionRecipeV1(first.run.executionInputEnvelope);
    expect(frozen).toMatchObject({ kind: 'available', recipe: { target: { kind: 'contributedAction', action },
        template: { t: 'plain', v: { actionInput: { kind: 'literal', value: { project: 'original' } } } } } });
    await db.automation.update({ where: { id: automation.id }, data: { name: 'Renamed after admission' } });
    await db.automationRun.update({ where: { id: first.run.id }, data: { leaseExpiresAt: new Date(0) } });
    const rejoined = await claimAutomationRun({ accountId: account.id, machineId, leaseDurationMs: 30_000, scope: 'execution' });
    expect(rejoined.run).toMatchObject({ id: first.run.id, executionInputEnvelope: first.run.executionInputEnvelope });
    if (!rejoined.run || !rejoined.accountCurrentness) throw new Error('Action Run was not reclaimed');
    expect(await startAutomationRun({ accountId: account.id, machineId, runId: rejoined.run.id,
        attempt: rejoined.run.attempt, accountCurrentness: rejoined.accountCurrentness })).not.toBeNull();
    await cancelAutomationRun({ accountId: account.id, runId: rejoined.run.id });
    expect(await db.automationRun.findUnique({ where: { id: rejoined.run.id }, select: { state: true } })).toEqual({ state: 'outcome_uncertain' });
});
