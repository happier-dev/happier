import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventRouter } from '@/app/events/eventRouter';
import type { SocketRoomEventName } from '@/app/events/socketRoomEmitter';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { createAutomation } from './automationCrudService';
import { updateAutomationSettings } from './automationSettingsService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Automation settings write cost', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
        // A trigger at the real storage boundary counts physical row changes,
        // including cursor allocation, without substituting any domain logic.
        await db.$executeRawUnsafe('CREATE TABLE "AutomationSettingsWriteObservation" ("accountId" text NOT NULL)');
        await db.$executeRawUnsafe(`CREATE FUNCTION "observeAutomationSettingsAccountWrite"() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
                INSERT INTO "AutomationSettingsWriteObservation" ("accountId") VALUES (NEW."id");
                RETURN NEW;
            END $$`);
        await db.$executeRawUnsafe(`CREATE TRIGGER "observeAutomationSettingsAccountWrite"
            AFTER UPDATE ON "Account" FOR EACH ROW EXECUTE FUNCTION "observeAutomationSettingsAccountWrite"()`);
    });
    afterAll(async () => {
        eventRouter.clearIo();
        if (!connected) return;
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "observeAutomationSettingsAccountWrite" ON "Account"');
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "observeAutomationSettingsAccountWrite"()');
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "AutomationSettingsWriteObservation"');
        await db.$disconnect();
    });

    async function writeCount(accountId: string): Promise<number> {
        const [row] = await db.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count FROM "AutomationSettingsWriteObservation" WHERE "accountId" = ${accountId}
        `;
        return row.count;
    }

    it('writes and wakes only for changed policy, independent of the assigned Machine count', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machineIds = Array.from({ length: 100 }, () => randomUUID());
        await db.machine.createMany({ data: machineIds.map(id => ({ id, accountId: account.id, metadata: '{}' })) });
        await createAutomation({ accountId: account.id, input: {
            name: 'Settings write cost', enabled: false,
            schedule: { kind: 'interval', everyMs: 60_000, timezone: null }, targetType: 'new_session',
            templateCiphertext: JSON.stringify({ kind: 'happier_automation_template_plain_v1', payload: { prompt: 'policy fixture' } }),
            assignments: machineIds.map(machineId => ({ machineId })),
        } });
        const baseline = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        const baselineWrites = await writeCount(account.id);
        const emissions: unknown[] = [];
        // Socket.IO room delivery is the network boundary. Keep publication,
        // recipient routing, cursors and post-commit execution real.
        eventRouter.setIo({ to: () => ({ emit: (_event: SocketRoomEventName, payload: unknown) => { emissions.push(payload); },
            disconnectSockets: () => {} }) });
        try {
            const current = { maxActiveRunsPerMachine: 4, runRetention: 'thirtyDays' as const };
            for (let index = 0; index < 20; index++) {
                expect(await updateAutomationSettings({ accountId: account.id, settings: current })).toEqual(current);
            }
            expect(await writeCount(account.id) - baselineWrites).toBe(0);
            expect(emissions).toHaveLength(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toEqual(baseline);
            expect(await db.accountChange.count({ where: { accountId: account.id, entityId: 'automation-settings' } })).toBe(0);

            for (const settings of [
                { maxActiveRunsPerMachine: 2, runRetention: 'thirtyDays' as const },
                { maxActiveRunsPerMachine: 2, runRetention: 'keepForever' as const },
            ]) expect(await updateAutomationSettings({ accountId: account.id, settings })).toEqual(settings);
            expect(await writeCount(account.id) - baselineWrites).toBe(4);
            expect(emissions.filter(payload => typeof payload === 'object' && payload !== null && 'body' in payload
                && typeof payload.body === 'object' && payload.body !== null && 't' in payload.body
                && payload.body.t === 'automation-assignment-updated')).toHaveLength(200);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(baseline.seq + 2);
            expect(await db.accountChange.count({ where: { accountId: account.id, entityId: 'automation-settings' } })).toBe(1);
        } finally {
            eventRouter.clearIo();
            await db.automation.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('concurrent equal replacements produce one change, while a missing Account remains absent', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const settings = { maxActiveRunsPerMachine: 2, runRetention: 'keepForever' as const };
        try {
            expect(await Promise.all(Array.from({ length: 8 }, () => updateAutomationSettings({ accountId: account.id, settings }))))
                .toEqual(Array.from({ length: 8 }, () => settings));
            expect(await writeCount(account.id)).toBe(2);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(1);
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(1);
            expect(await updateAutomationSettings({ accountId: randomUUID(), settings })).toBeNull();
        } finally {
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
