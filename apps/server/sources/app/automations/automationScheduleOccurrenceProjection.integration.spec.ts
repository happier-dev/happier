import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { loadAutomationScheduleOccurrences } from './automationScheduleOccurrenceProjection';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';

describe('Automation schedule occurrence projection', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => { harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-backup-freshness-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('keeps each trigger occurrence, actual start and approval hold separate, excluding other Accounts and old revisions', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const automation = await db.automation.create({ data: { accountId: account.id, name: 'Backups', templateVersion: 1,
            templateCiphertext: 'unopened-by-schedule-fact-reader' } });
        const triggers = await Promise.all(['missing', 'started', 'held'].map(id => db.automationTrigger.create({ data: {
            id: `${id}-${randomUUID()}`, automationId: automation.id, kind: 'schedule', scheduleKind: 'interval',
            everyMs: 60_000, revision: 2, nextRunAt: new Date(100),
        } })));
        const run = (index: number, overrides: Partial<Parameters<typeof db.automationRun.create>[0]['data']> = {}) =>
            db.automationRun.create({ data: { accountId: account.id, automationId: automation.id,
                triggerId: triggers[index]!.id, causeKind: 'trigger', causeTriggerKind: 'schedule', causeTriggerRevision: 2,
                occurrenceKey: randomUUID(), causeOccurredAt: new Date(100),
                causeScheduledFor: new Date(100), scheduledAt: new Date(100), dueAt: new Date(100), ...overrides } });
        await run(0);
        await run(1, { startedAt: new Date(120), state: 'succeeded' });
        await run(2, { state: 'waiting_for_review' });
        await run(0, { causeTriggerRevision: 1, causeScheduledFor: new Date(200), startedAt: new Date(210), state: 'succeeded' });
        let requests = 0;
        const release = observePrismaRequests(db, { before: () => { requests++; } });
        let result: Awaited<ReturnType<typeof loadAutomationScheduleOccurrences>>;
        try { result = await loadAutomationScheduleOccurrences(account.id, [automation.id], 300); }
        finally { release(); }
        expect(requests, 'one set read, not one read per trigger').toBe(1);
        expect(result.get(automation.id)).toEqual(expect.arrayContaining([
            { triggerId: triggers[0]!.id, triggerRevision: 2, scheduledFor: 100, startedAt: null, held: false },
            { triggerId: triggers[1]!.id, triggerRevision: 2, scheduledFor: 100, startedAt: 120, held: false },
            { triggerId: triggers[2]!.id, triggerRevision: 2, scheduledFor: 100, startedAt: null, held: true },
        ]));
        expect(result.get(automation.id)).toHaveLength(3);
        expect(await loadAutomationScheduleOccurrences('another-account', [automation.id], 300)).toEqual(new Map());
        expect(await loadAutomationScheduleOccurrences(account.id, [], 300)).toEqual(new Map());
    });
});
