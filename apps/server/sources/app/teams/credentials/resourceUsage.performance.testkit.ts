import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { queryTeamCredentialUsage } from './resourceUsage';
import { TeamCredentialUsageQueryInputV1Schema } from '@happier-dev/protocol/teams';

const authentication = { env: process.env, authenticationAuthority: 'present_user', authenticationEvidence: [] } as const;

/** Shared real-database workload: pre-range counters, deltas, a reset, and denied Session attribution. */
export function defineResourceUsagePerformanceContract(input: Readonly<{
    provider: 'sqlite' | 'postgres';
    queries: Prisma.QueryEvent[];
}>) {
    it('reads a Team aggregate in sets rather than multiplying SQL statements by its credentials', async () => {
        const statements: number[] = [];
        // The last sample exercises Prisma batching, including the repeated
        // resource predicate used for cumulative Session history and access.
        for (const resourceCount of [2, 30, 1005]) {
            const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: randomUUID() } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
            const resourceIds = Array.from({ length: resourceCount }, () => randomUUID());
            await db.teamCredentialResource.createMany({ data: resourceIds.map(id => ({
                id, teamId: team.id, custodianAccountId: manager.id, displayName: id,
                disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
                allMembersDeliveryMode: 'brokered',
            })) });
            await db.session.createMany({ data: resourceIds.map(id => ({ id, accountId: manager.id,
                tag: id, metadata: '{}', encryptionMode: 'plain' })) });
            const observedAt = new Date();
            await db.usageEvent.createMany({ data: resourceIds.map(resourceId => ({
                accountId: manager.id, sessionId: resourceId, observedAt, agentId: 'codex', source: 'codex_app_server',
                scope: 'turn_delta', totalTokens: 1, teamCredentialResourceId: resourceId,
                teamCredentialActorAccountId: manager.id, credentialDeliveryMode: 'brokered',
            })) });
            const query = TeamCredentialUsageQueryInputV1Schema.parse({ subject: { kind: 'team', teamId: team.id },
                startMs: observedAt.getTime(), endMs: observedAt.getTime(), breakdown: 'session' });
            input.queries.length = 0;
            const result = await queryTeamCredentialUsage(manager.id, query, authentication);
            statements.push(input.queries.filter(event => /^\s*(?:SELECT|WITH)\b/i.test(event.query)).length);
            if ('ok' in result) throw new Error(`Usage refused: ${result.error}`);
            expect(result.totals.tokens.total).toBe(resourceCount);
            expect(result.limits).toEqual([]);
            console.info('TEAMSPERF_AGGREGATE_SQL', JSON.stringify({ provider: input.provider, resourceCount,
                statements: statements.at(-1),
                maxBindings: Math.max(0, ...input.queries.map(event => (JSON.parse(event.params) as unknown[]).length)),
            }));
        }
        expect(statements[1]).toBeLessThanOrEqual(statements[0]!);
    });

    it('keeps page SQL work independent of the historical Session population while preserving cumulative and denied groups', async () => {
        const samples: Array<{ sessions: number; statements: number; sessionReads: number; maxBindings: number }> = [];
        for (const sessionCount of [30, 300]) {
            const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
            const other = await db.account.create({ data: { encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: randomUUID() } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: 'admin' } });
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: manager.id, displayName: 'Scale resource',
                disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed', sourceBindingJson: '{}',
                allMembersDeliveryMode: 'brokered',
            } });
            const sessionIds = Array.from({ length: sessionCount }, () => randomUUID());
            await db.session.createMany({ data: sessionIds.map((id, index) => ({
                id, accountId: index % 2 === 0 ? manager.id : other.id, tag: randomUUID(),
                metadata: '{}', encryptionMode: 'plain',
            })) });
            const startMs = Date.UTC(2026, 9, 1, 12);
            const observations = [
                [-1, 'session_cumulative', 100], [1, 'turn_delta', 10], [2, 'session_cumulative', 120],
                [3, 'turn_delta', 5], [4, 'session_cumulative', 5], [5, 'turn_delta', 7],
                [6, 'session_cumulative', 20],
            ] as const;
            // Chunk fixture inserts by Session: 7 rows x the schema's fixed fields stays below SQLite's bind budget.
            for (const sessionId of sessionIds) {
                await db.usageEvent.createMany({ data: observations.map(([offset, scope, tokens]) => ({
                    id: randomUUID(), accountId: manager.id, sessionId, observedAt: new Date(startMs + offset),
                    createdAt: new Date(startMs + offset), agentId: 'codex', source: 'codex_app_server',
                    scope, isCumulative: scope !== 'turn_delta', inputTokens: tokens, totalTokens: tokens,
                    requestCount: scope === 'turn_delta' ? 1 : 0, teamCredentialResourceId: resource.id,
                    teamCredentialActorAccountId: manager.id, credentialDeliveryMode: 'brokered',
                })) });
            }
            input.queries.length = 0;
            const result = await queryTeamCredentialUsage(manager.id, {
                resourceId: resource.id, startMs, endMs: startMs + 10,
                granularity: 'day', costMode: 'auto', breakdown: 'session',
            }, authentication);
            const captured = input.queries.slice();
            const selects = captured.filter(query => /^\s*(?:SELECT|WITH)\b/i.test(query.query));
            samples.push({ sessions: sessionCount, statements: selects.length,
                sessionReads: selects.filter(query => /FROM\s+(?:["`](?:public|main)["`]\.)?["`]Session["`](?:\s|$)/.test(query.query)).length,
                maxBindings: Math.max(0, ...captured.map(query => (JSON.parse(query.params) as unknown[]).length)),
            });
            console.info('TEAMSPERF_USAGE_SQL', JSON.stringify({ provider: input.provider, samples }));
            if (samples.length === 2) {
                expect(samples[1]!.sessionReads).toBeLessThanOrEqual(samples[0]!.sessionReads);
                expect(samples[1]!.statements).toBeLessThanOrEqual(samples[0]!.statements);
                expect(samples[1]!.maxBindings).toBeLessThanOrEqual(samples[0]!.maxBindings);
            }
            if ('ok' in result) throw new Error(`Usage refused: ${result.error}`);
            expect(result.totals.tokens.total).toBe(40 * sessionCount);
            expect(result.totals.requestCount).toBe(3 * sessionCount);
            expect(result.totals.eventCount).toBe(5 * sessionCount);
            expect(result.series).toHaveLength(1);
            expect(result.series[0]?.totals).toEqual(result.totals);
            expect(result.coverage.agentObservationCount).toBe(6 * sessionCount);
            const ownedSessionIds = sessionIds.filter((_, index) => index % 2 === 0).sort((left, right) => left.localeCompare(right));
            const expectedKeys = ['unavailable_session', ...ownedSessionIds].slice(0, 50);
            expect(result.breakdown?.map(row => row.key)).toEqual(expectedKeys);
            expect(result.breakdown?.[0]?.totals.tokens.total).toBe(20 * sessionCount);
            expect(result.breakdown?.slice(1).every(row => row.totals.tokens.total === 40)).toBe(true);
            expect(result.nextCursor !== null).toBe(sessionCount === 300);
        }
        console.info('TEAMSPERF_USAGE_SQL', JSON.stringify({ provider: input.provider, samples }));
        expect(samples[1]!.sessionReads).toBeLessThanOrEqual(samples[0]!.sessionReads);
        expect(samples[1]!.statements).toBeLessThanOrEqual(samples[0]!.statements);
        expect(samples[1]!.maxBindings).toBeLessThanOrEqual(samples[0]!.maxBindings);
    });
}
