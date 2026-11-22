import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol';
import { AutomationActionAdmitRequestV1Schema } from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import { decodeBase64 } from 'privacy-kit';
import { admitAutomationActionOccurrencesV1 } from './automationActionAdmissionService';
import { createAutomation } from './automationCrudService';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { readAutomationActorConsentReferencesInTx } from './automationSharedWorkflowSummaries';

describe('Consent Run admission (real database)', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        if (process.env.HAPPIER_DB_PROVIDER === 'sqlite') {
            harness = await createLightSqliteHarness({ tempDirPrefix: 'consent-run-', initEncrypt: true });
        } else {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error('Use the disposable PostgreSQL DB-contract harness');
            }
            initDbPostgres();
            await db.$connect();
            const previousSecret = process.env.HANDY_MASTER_SECRET;
            process.env.HANDY_MASTER_SECRET = 'consent-run-dbcontract-test-secret';
            try { await initEncrypt(); }
            finally {
                if (previousSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
                else process.env.HANDY_MASTER_SECRET = previousSecret;
            }
        }
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); else await db.$disconnect(); });

    it('uses the invocation Machine for a projectless saved Action Link', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const otherAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
        const makeMachine = (accountId: string) => db.machine.create({ data: { id: randomUUID(), accountId,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const [machine, foreignMachine] = await Promise.all([makeMachine(account.id), makeMachine(otherAccount.id)]);
        const automationId = randomUUID();
        const triggerId = randomUUID();
        const executionRecipe = { v: 2 as const, templateVersion: 1, triggerEvidence: null,
            placement: 'action_invocation' as const,
            workflow: { t: 'plain' as const, v: { executionTarget: { kind: 'session' as const } } } };
        const created = await createAutomation({ accountId: account.id, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId, name: 'Action Link', enabled: true, workflowDefinitionId: 'builtin:review-and-converge',
            executionRecipe, assignments: [], triggers: [{ triggerId, trigger: {
                kind: 'action', enabled: true, actionIds: ['deployments.deploy'], phase: 'after',
            } }],
        }) });
        const ref = { automationId, triggerId, triggerRevision: created.triggers[0]!.revision };
        const evidence = { v: 1 as const, kind: 'action' as const, actionId: 'deployments.deploy',
            requestId: randomUUID(), phase: 'after' as const, occurredAt: Date.now(), subjects: [],
            status: 'succeeded' as const };
        const admit = (machineId?: string) => admitAutomationActionOccurrencesV1({ accountId: account.id,
            input: AutomationActionAdmitRequestV1Schema.parse({ triggers: [ref], evidence: { ...evidence, ...(machineId ? { machineId } : {}) } }) });

        expect(await admit()).toMatchObject({ results: [{ kind: 'skipped', reason: 'machineRequired' }] });
        expect(await admit(foreignMachine.id)).toMatchObject({ results: [{ kind: 'skipped', reason: 'machineRequired' }] });
        expect(await db.automationRun.count({ where: { automationId } })).toBe(0);
        const admitted = (await admit(machine.id)).results[0]!;
        expect(admitted.kind).toBe('admitted');
        if (admitted.kind !== 'admitted') throw new Error(JSON.stringify(admitted));
        expect(await db.automationRunAssignment.findMany({ where: { runId: admitted.runId },
            select: { machineId: true, admittedMachineInstallationId: true } })).toEqual([
            { machineId: machine.id, admittedMachineInstallationId: machine.installationId },
        ]);
        expect(await db.automationAssignment.count({ where: { automationId } })).toBe(0);
    });

    it('reads all selected actor consent Trigger references, including paused and deleted-definition history', async () => {
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = { automationId: randomUUID(), triggerId: randomUUID() };
        const makeReference = async (accountId: string, consentFor: typeof source, state: 'active' | 'paused' | 'deleted' = 'active') => {
            const automationId = randomUUID();
            const triggerId = randomUUID();
            await db.automation.create({ data: { id: automationId, accountId, name: 'Actor consent history',
                enabled: state === 'active', deletedAt: state === 'deleted' ? new Date() : null,
                templateVersion: 1, templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({
                    templateVersion: 1, directory: '/repo', prompt: 'Review' })), targetType: null,
                triggers: { create: { id: triggerId, kind: 'action', enabled: state === 'active', revision: 1,
                    consentForAutomationId: consentFor.automationId, consentForTriggerId: consentFor.triggerId,
                    consentedWorkflowRevision: 1 } } } });
            return { automationId, triggerId, consentFor };
        };
        const active = await makeReference(actor.id, source);
        const paused = await makeReference(actor.id, source, 'paused');
        const deleted = await makeReference(actor.id, source, 'deleted');
        await makeReference(other.id, source);
        await makeReference(actor.id, { automationId: source.automationId, triggerId: randomUUID() });
        const references = await inTx(tx => readAutomationActorConsentReferencesInTx(tx, {
            accountId: actor.id, sourceTriggers: [source],
        }));
        expect([...references].sort((a, b) => a.triggerId.localeCompare(b.triggerId)))
            .toEqual([active, paused, deleted].sort((a, b) => a.triggerId.localeCompare(b.triggerId)));
        expect(await inTx(tx => readAutomationActorConsentReferencesInTx(tx, {
            accountId: actor.id, sourceTriggers: [],
        }))).toEqual([]);
    });
});
