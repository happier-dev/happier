import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { logger } from '@/utils/logging/log';
import { withWebLatencyTrace } from '@/utils/webLatencyTrace';
import { admitAutomationRunsTx } from './automationRunAdmissionService';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Automation batch publication admission (PostgreSQL)', () => {
    let accountId: string | undefined;
    const originalLogLevel = logger.level;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        vi.stubEnv('HAPPIER_FEATURE_WORKFLOWS__ENABLED', '1');
        initDbPostgres();
        await db.$connect();
    });
    beforeEach(() => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        vi.stubEnv('HAPPIER_FEATURE_WORKFLOWS__ENABLED', '1');
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        logger.level = originalLogLevel;
        if (!accountId) return;
        await db.automationRun.deleteMany({ where: { accountId } });
        await db.automation.deleteMany({ where: { accountId } });
        await db.session.deleteMany({ where: { accountId } });
        await db.machine.deleteMany({ where: { accountId } });
        await db.account.delete({ where: { id: accountId } });
        accountId = undefined;
    });
    afterAll(async () => { await db.$disconnect(); });

    it('attaches five Workflow bodies with one admitted Session audience census', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accountId = account.id;
        const session = await db.session.create({ data: { accountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId, metadata: '{}' } });
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
                inlineDefinition: { version: 1, blocks: [{ kind: 'action', id: 'notice', actionId: 'notifications.notify_me',
                    input: { message: { kind: 'literal', value: 'Run finished' } } }] } } } });
        if (recipe.kind !== 'available') throw new Error('Workflow recipe unavailable');
        const automations = [];
        for (let index = 0; index < 5; index++) {
            const automation = await db.automation.create({ data: { accountId, scopeSessionId: session.id,
                name: `Batch habit ${index}`, enabled: true, templateCiphertext: recipe.serialized, templateVersion: 1 } });
            await db.automationAssignment.create({ data: { automationId: automation.id, machineId: machine.id, enabled: true } });
            automations.push(automation);
        }
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        logger.level = 'trace';
        const phases: string[] = [];
        let admitting = false;
        vi.spyOn(logger, 'trace').mockImplementation(record => {
            if (admitting && typeof record === 'object' && record !== null && 'module' in record && record.module === 'web-latency'
                && 'phase' in record && typeof record.phase === 'string') phases.push(record.phase);
        });
        const now = new Date();
        const results = await withWebLatencyTrace(randomUUID(), () => inTx(async tx => {
            admitting = true;
            try {
                return await admitAutomationRunsTx({ tx, accountId: account.id,
                    admissions: automations.map(automation => ({ automationId: automation.id, now,
                        cause: { kind: 'manual' as const, invokedAt: now.getTime() } })),
                });
            } finally { admitting = false; }
        }));
        expect(results.map(result => result.kind)).toEqual(Array(5).fill('admitted'));
        const runs = await db.automationRun.findMany({ where: { accountId }, select: { executionInputEnvelope: true, workflowCustodyState: true } });
        expect(runs).toHaveLength(5);
        for (const run of runs) {
            expect(JSON.parse(run.executionInputEnvelope ?? 'null')).toMatchObject(recipe.recipe.workflow);
            expect(run.workflowCustodyState).not.toBeNull();
        }
        expect(phases.filter(phase => phase === 'db.SessionGrant.findMany'),
            'Workflow attachment consumes the batch admission instead of resolving the same Session audience per Run').toHaveLength(1);
    });

    it('rejects an encrypted Workflow body for a plain Account without persisting a Run', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accountId = account.id;
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId, metadata: '{}' } });
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: 'encrypted', c: 'opaque-encrypted-workflow' } });
        if (recipe.kind !== 'available') throw new Error('Encrypted Workflow recipe unavailable');
        const automation = await db.automation.create({ data: { accountId, name: 'Mismatched Workflow body', enabled: true,
            templateCiphertext: recipe.serialized, templateVersion: 1 } });
        await db.automationAssignment.create({ data: { automationId: automation.id, machineId: machine.id, enabled: true } });
        const now = new Date();
        await expect(inTx(tx => admitAutomationRunsTx({ tx, accountId: account.id,
            admissions: [{ automationId: automation.id, now, cause: { kind: 'manual', invokedAt: now.getTime() } }],
        }))).rejects.toMatchObject({ name: 'WorkflowRunServiceError', code: 'content_unavailable' });
        expect(await db.automationRun.count({ where: { accountId } })).toBe(0);
    });
});
