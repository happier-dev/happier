import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serializeAutomationRunExecutionRecipeV1 } from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

import { failAutomationRun } from './automationRunService';
import {
    automationAccountCurrentnessSelect,
    deriveAutomationAccountCurrentnessWitness,
} from './automationAccountCurrentness';
import {
    toAutomationRunV3DetailApiDto,
    toAutomationRunV3ListApiDto,
} from './automationApiProjection';

const EXECUTION_INPUT_ENVELOPE = (() => {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: {
            t: 'plain',
            v: { v: 1, prompt: 'Record a private failure detail.' },
        },
        triggerEvidence: null,
        target: {
            kind: 'newSession',
            spawn: {
                executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                directory: '/tmp/automation-failure-detail',
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                },
            },
        },
    });
    if (serialized.kind !== 'available') {
        throw new Error('Expected strict Automation Run test recipe to serialize');
    }
    return serialized.serialized;
})();

async function readCurrentness(accountId: string) {
    const account = await db.account.findUniqueOrThrow({
        where: { id: accountId },
        select: automationAccountCurrentnessSelect,
    });
    const currentness = deriveAutomationAccountCurrentnessWitness(account);
    if (currentness === null) {
        throw new Error('Expected Automation Account currentness');
    }
    return currentness;
}

describe('Automation Run private failure-detail persistence', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-automation-failure-detail-',
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it('persists a V3 failure as an opaque detail envelope while publishing only errorCode', async () => {
        const account = await db.account.create({
            data: { encryptionMode: 'plain' },
            select: { id: true },
        });
        const machine = await db.machine.create({
            data: {
                id: 'machine-failure-detail',
                accountId: account.id,
                metadata: '{}',
            },
            select: { id: true },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: 'Private failure detail',
                enabled: true,
                scheduleKind: 'interval',
                everyMs: 120_000,
                targetType: 'new_session',
                templateCiphertext: EXECUTION_INPUT_ENVELOPE,
                templateVersion: 1,
            },
            select: { id: true },
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: 'running',
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 30_000),
                startedAt: new Date(Date.now() - 20_000),
                claimedByMachineId: machine.id,
                leaseExpiresAt: new Date(Date.now() + 30_000),
                attempt: 1,
                executionInputEnvelope: EXECUTION_INPUT_ENVELOPE,
            },
            select: { id: true },
        });
        const privateDetail = 'The worker saw /private/project and exited.';
        const errorDetailEnvelope = JSON.stringify({
            t: 'plain',
            v: {
                v: 1,
                correspondence: {
                    automationId: automation.id,
                    runId: run.id,
                },
                detail: privateDetail,
            },
        });

        const failed = await failAutomationRun({
            accountId: account.id,
            runId: run.id,
            machineId: machine.id,
            attempt: 1,
            accountCurrentness: await readCurrentness(account.id),
            errorCode: 'worker_crashed',
            errorDetailEnvelope,
        });

        expect(failed).toEqual(expect.objectContaining({
            id: run.id,
            state: 'failed',
            errorCode: 'worker_crashed',
            errorMessage: errorDetailEnvelope,
        }));
        const stored = await db.automationRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { errorCode: true, errorMessage: true },
        });
        expect(stored.errorCode).toBe('worker_crashed');
        expect(stored.errorMessage).toBe(errorDetailEnvelope);
        expect(stored.errorMessage).not.toBe(privateDetail);

        const listItem = toAutomationRunV3ListApiDto(failed!);
        expect(listItem).not.toHaveProperty('errorDetailEnvelope');
        expect(JSON.stringify(listItem)).not.toContain(privateDetail);
        expect(toAutomationRunV3DetailApiDto(failed!, 'plain').errorDetailEnvelope)
            .toBe(errorDetailEnvelope);

        const event = await db.automationRunEvent.findFirstOrThrow({
            where: { runId: run.id, type: 'run_failed' },
            select: { payload: true },
        });
        expect(event.payload).toEqual({
            machineId: machine.id,
            errorCode: 'worker_crashed',
        });
        expect(JSON.stringify(event.payload)).not.toContain(privateDetail);
    });
});
