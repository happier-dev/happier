import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { deleteNativeUsageHistory } from '@/app/usage/usageWriteService';
import { refreshTeamCredentialUsageCountersInTx } from './teamCredentialUsageCounters';
import { evaluateTeamCredentialUsageAdmissionLimitsInTx } from './teamCredentialUsageLimits';

it('deletes a native history larger than a SQLite statement and refreshes its linked Session', async () => {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-native-delete-', initAuth: false });
    try {
        const account = await db.account.create({ data: { publicKey: 'native-delete-bind-probe' } });
        const machine = await db.machine.create({ data: { id: 'native-delete-machine', accountId: account.id, metadata: '{}' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'native-delete-link', metadata: '{}' } });
        const subject = {
            kind: 'native', machineId: machine.id, linkedSessionId: session.id,
            agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root', nativeSessionKey: 'native',
        };
        const event = {
            accountId: account.id, machineId: machine.id, agentId: 'codex', scope: 'turn_delta', totalTokens: 1,
        };
        const eventCount = 1_200;
        await db.usageEvent.createMany({ data: Array.from({ length: eventCount }, (_, index) => ({
            ...event, observedAt: new Date(index + 1), source: 'native',
            metadata: { captureOrigin: 'native', accountingSubject: subject },
        })) });
        const runtime = await db.usageEvent.create({ data: { ...event, sessionId: session.id,
            observedAt: new Date(1), source: 'runtime' } });
        await expect(deleteNativeUsageHistory(account.id, { machineId: machine.id, sourceRootKey: subject.sourceRootKey }))
            .resolves.toEqual({ ok: true, deletedEventCount: eventCount });
        const remaining = await db.usageEvent.findMany({ where: { accountId: account.id }, select: { id: true } });
        expect(remaining).toEqual([{ id: runtime.id }]);
    } finally {
        await harness.close();
    }
}, 120_000);

it('refreshes both ends of a resource date range found across distinct Session chunks', async () => {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'team-spend-session-chunks-', initAuth: false });
    try {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Session chunk spend contract' } });
        const resource = await db.teamCredentialResource.create({ data: {
            teamId: team.id, custodianAccountId: account.id, displayName: 'Chunked provider',
            sourceBindingJson: '{}', disclosureCeiling: 'brokered_only', sessionUsePolicy: 'team_context_required',
            allMembersDeliveryMode: 'brokered',
        } });
        const start = new Date('2026-09-06T12:00:00Z');
        const middle = new Date('2026-09-07T12:00:00Z');
        const end = new Date('2026-09-08T12:00:00Z');
        const limit = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: resource.id, subjectKind: 'resource', subjectId: '', period: 'day', metric: 'total_tokens',
            maximum: '10000', createdAt: new Date('2026-09-01T00:00:00Z'),
        } });
        const sessionIds = Array.from({ length: 1_200 }, () => randomUUID());
        await db.session.createMany({ data: sessionIds.map(id => ({
            id, accountId: account.id, tag: id, metadata: '{}', encryptionMode: 'plain',
        })) });
        const read = (now: Date) => inTx(tx => evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
            resourceId: resource.id, actorAccountId: account.id, now,
        }));
        for (const date of [start, middle, end]) {
            await expect(read(date)).resolves.toMatchObject({ ok: true, applied: [{ limitId: limit.id, recorded: 0 }] });
        }
        const observed = (sessionId: string, observedAt: Date, totalTokens: number) => ({
            accountId: account.id, sessionId, turnId: 'turn', observedAt, totalTokens, agentId: 'codex',
            source: 'runtime', scope: 'turn_delta', teamCredentialResourceId: resource.id,
            teamCredentialActorAccountId: account.id, credentialDeliveryMode: 'brokered',
        });
        // The middle date alone cannot select either outer bucket. The same resource
        // appears at opposite ends of the Session list, so both chunks must contribute.
        await db.usageEvent.createMany({ data: sessionIds.map((id, index) => {
            if (index === 0) return observed(id, start, 3);
            if (index === sessionIds.length - 1) return observed(id, end, 7);
            return observed(id, middle, 1);
        }) });
        await inTx(tx => refreshTeamCredentialUsageCountersInTx(tx, { sessionIds, changedObservedAts: [middle] }));
        for (const [date, recorded] of [[start, 3], [middle, sessionIds.length - 2], [end, 7]] as const) {
            await expect(read(date)).resolves.toMatchObject({ ok: true, applied: [{ limitId: limit.id, recorded }] });
        }
    } finally {
        await harness.close();
    }
}, 120_000);
