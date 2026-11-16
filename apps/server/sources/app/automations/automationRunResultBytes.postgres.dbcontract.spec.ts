import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sealAutomationRunResultStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationReplyHandoffStoredContent';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { deriveAutomationAccountCurrentnessWitness } from './automationAccountCurrentness';
import { encodeAutomationRunCause } from './automationRunCauseCodec';
import { succeedAutomationRun } from './automationRunService';
import { getAutomationRun } from './automationCrudService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Automation result byte storage', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use only the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        // Feature migrations stay draft until integration; only this disposable schema is prepared.
    });
    afterAll(async () => { await db.$disconnect(); });
    it('settles with physical bytes and returns the exact envelope from terminal and detail owners', async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        try {
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
            const templateCiphertext = JSON.stringify({ kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: randomBytes(32).toString('base64') });
            const automation = await db.automation.create({ data: { accountId: account.id, name: 'byte storage', enabled: false,
                targetType: 'existing_session', templateCiphertext } });
            const invokedAt = Date.now();
            const run = await db.automationRun.create({ data: { accountId: account.id, automationId: automation.id,
                originKind: 'automation', ...encodeAutomationRunCause({ kind: 'manual', invokedAt }),
                state: 'running', attempt: 1, revision: 0,
                executionInputEnvelope: JSON.stringify({ kind: 'happier_automation_run_execution_input_v1',
                    targetType: 'existing_session', templateVersion: 1, templateCiphertext, origin: { kind: 'manual', invokedAt } }),
                scheduledAt: new Date(), dueAt: new Date(), claimedByMachineId: machine.id,
                startedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000) } });
            const accountCurrentness = deriveAutomationAccountCurrentnessWitness(account);
            if (!accountCurrentness) throw new Error('Fixture currentness unavailable');
            const result = sealAutomationRunResultStoredEnvelopeV1({ mode: 'e2ee', material: { type: 'dataKey', machineKey: randomBytes(32) },
                randomBytes, correspondence: { accountId: account.id, automationId: automation.id, runId: run.id },
                result: { v: 1, kind: 'text', text: 'result '.repeat(32) } });
            const resultEnvelope = JSON.stringify(result);
            const settled = await succeedAutomationRun({ accountId: account.id, runId: run.id, machineId: machine.id,
                attempt: 1, accountCurrentness, resultEnvelope });
            expect(settled).toMatchObject({ state: 'succeeded', resultEnvelope });
            const [physical] = await db.$queryRaw<Array<{ resultEnvelope: string | null; storedBytes: number | null; rowBytes: number }>>`
                SELECT "resultEnvelope", octet_length("resultEnvelopeBytes")::int AS "storedBytes", pg_column_size(run)::int AS "rowBytes"
                FROM "AutomationRun" run WHERE "id" = ${run.id}`;
            expect(physical.resultEnvelope).toBe(JSON.stringify({ t: 'encrypted', c: '' }));
            expect(physical.storedBytes).toBeGreaterThan(0);
            expect(await getAutomationRun({ accountId: account.id, automationId: automation.id, runId: run.id }))
                .toMatchObject({ resultEnvelope });
            // Legacy persisted envelopes stay readable without a backfill.
            await db.automationRun.update({ where: { id: run.id }, data: { resultEnvelope, resultEnvelopeBytes: null } });
            const [legacySize] = await db.$queryRaw<Array<{ rowBytes: number }>>`
                SELECT pg_column_size(run)::int AS "rowBytes" FROM "AutomationRun" run WHERE "id" = ${run.id}`;
            expect(physical.rowBytes).toBeLessThan(legacySize.rowBytes);
            console.info('STORAGE_CODEC_AUTOMATION_SAMPLE', JSON.stringify({ byteRow: physical.rowBytes,
                legacyRow: legacySize.rowBytes, storedBytes: physical.storedBytes }));
            expect(await getAutomationRun({ accountId: account.id, automationId: automation.id, runId: run.id }))
                .toMatchObject({ resultEnvelope });
        } finally {
            await db.automationRun.deleteMany({ where: { accountId: account.id } });
            await db.automation.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
