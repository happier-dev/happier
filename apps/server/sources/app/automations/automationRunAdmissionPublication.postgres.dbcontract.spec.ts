import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { buildAutomationRunSummaryChangeEntityIdV1 } from '@happier-dev/protocol/changes';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prisma';
import { logger } from '@/utils/logging/log';
import { withWebLatencyTrace } from '@/utils/webLatencyTrace';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAutomationActionRoutes } from '@/app/api/routes/automations/registerAutomationActionRoutes';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { getWorkflowPublicationAudienceInTx } from '@/app/workflows/workflowPublicationAudience';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
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

    it('reads one occurrence page for three matched triggers and rejoins the same Runs after trigger edits', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accountId = account.id;
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId, metadata: '{}' } });
        const triggers: { automationId: string; triggerId: string; triggerRevision: number }[] = [];
        for (const name of ['First', 'Second', 'Third']) {
            const automation = await db.automation.create({ data: {
                accountId, name, enabled: true, templateVersion: 1,
                templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({
                    templateVersion: 1, directory: '/repo', prompt: 'Review',
                })),
                assignments: { create: { machineId: machine.id, enabled: true } },
            } });
            const row = await db.automationTrigger.create({ data: {
                id: randomUUID(), automationId: automation.id, kind: 'action', enabled: true,
                definitionEnvelope: JSON.stringify({ t: 'plain', v: { kind: 'action' } }),
                phase: 'after', actionIdsJson: JSON.stringify(['scm.commit.create']),
            } });
            triggers.push({ automationId: row.automationId, triggerId: row.id, triggerRevision: row.revision });
        }
        const app = createAuthenticatedTestApp();
        registerAutomationActionRoutes(app);
        logger.level = 'trace';
        const phases: string[] = [];
        vi.spyOn(logger, 'trace').mockImplementation(record => {
            if (typeof record === 'object' && record !== null && 'module' in record && record.module === 'web-latency'
                && 'phase' in record && typeof record.phase === 'string') phases.push(record.phase);
        });
        const route = '/v1/automations/actions/admit';
        const payload = { evidence: { v: 1, kind: 'action', actionId: 'scm.commit.create', requestId: randomUUID(),
            phase: 'after', occurredAt: Date.now(), status: 'succeeded', subjects: [] }, triggers };
        const admit = () => withWebLatencyTrace(randomUUID(), () => app.inject({ method: 'POST', url: route,
            headers: { 'x-test-user-id': account.id }, payload }));
        try {
            const editedAutomationId = triggers[0]!.automationId;
            const definitionCursor = await inTx(tx => markAccountChanged(tx, {
                accountId: account.id, kind: 'automation', entityId: editedAutomationId,
            }));
            const original = await admit();
            expect(original.statusCode, original.body).toBe(200);
            const inserted = original.json().results;
            expect(inserted).toEqual(triggers.map(({ automationId, triggerId }) => ({
                kind: 'admitted', automationId, triggerId, runId: expect.any(String),
            })));
            expect(phases.filter(phase => phase === 'db.AutomationRun.findMany'), 'one retained occurrence read for the batch').toHaveLength(1);
            const changes = await db.accountChange.findMany({
                where: { accountId, kind: 'automation' }, orderBy: { cursor: 'asc' },
                select: { entityId: true, cursor: true },
            });
            expect(changes, 'three Run summaries preserve an unconsumed definition edit').toEqual([
                { entityId: editedAutomationId, cursor: definitionCursor.resolveCursor() },
                ...triggers.map(({ automationId }, index) => ({
                    entityId: buildAutomationRunSummaryChangeEntityIdV1(automationId, inserted[index].runId), cursor: expect.any(Number),
                })),
            ]);

            await db.automationTrigger.updateMany({ where: { id: { in: triggers.map(trigger => trigger.triggerId) } },
                data: { enabled: false, revision: { increment: 1 } } });
            phases.length = 0;
            const replay = await admit();
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json().results).toEqual(inserted.map((item: object) => ({ ...item, kind: 'rejoined' })));
            expect(phases.filter(phase => phase === 'db.AutomationRun.findMany'), 'one retained occurrence read for replay').toHaveLength(1);
            expect(await db.automationRun.count({ where: { accountId } })).toBe(triggers.length);
        } finally {
            await app.close();
        }
    });

    it('reads one Machine audience for both definition assignments and Action invocation placement', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        accountId = account.id;
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId, metadata: '{}' } });
        const automation = await db.automation.create({ data: {
            accountId, name: 'Published workflow', enabled: true, templateVersion: 1, templateCiphertext: '{}',
            assignments: { create: { machineId: machine.id, enabled: true } },
        } });
        const traced = await createDbMaintenanceClient('postgres', undefined, { log: [{ emit: 'event', level: 'query' }] });
        const statements: string[] = [];
        onDbClientQuery(traced, ({ query }) => statements.push(query));
        try {
            const audience = await traced.$transaction(tx => getWorkflowPublicationAudienceInTx(tx, {
                accountId: account.id, automationIds: [automation.id], machineIds: [machine.id],
            }));
            expect(audience).toEqual({ accountIds: [account.id], sessionIds: [], runIds: [] });
            expect(statements.filter(query => query.includes('SELECT "accountId" FROM "Machine" WHERE "id" = ANY')),
                'one physical wake audience read for the same Machine').toHaveLength(1);
        } finally {
            await traced.$disconnect();
        }
    });

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
        const automationIds: string[] = [];
        for (let index = 0; index < 5; index++) {
            const automation = await db.automation.create({ data: { accountId, scopeSessionId: session.id,
                name: `Batch habit ${index}`, enabled: true, templateCiphertext: recipe.serialized, templateVersion: 1 } });
            await db.automationAssignment.create({ data: { automationId: automation.id, machineId: machine.id, enabled: true } });
            automationIds.push(automation.id);
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
                    admissions: automationIds.map(automationId => ({ automationId, now,
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
