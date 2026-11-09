import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectUsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { writeLegacySessionTupleInTx } from '@/app/session/metadata/writeLegacySessionTuple';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerAccountUsageRoutes } from '@/app/api/routes/account/registerAccountUsageRoutes';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';

describe('persisted Usage timing demand', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'usage-timing-demand-',
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('prunes retained %s unknown documents by activity while preserving live turns', async mode => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: mode } });
        const nowMs = Date.UTC(2026, 10, 5, 12), day = 86_400_000;
        const make = async (daysAgo: number, live = false) => {
            const at = nowMs - daysAgo * day;
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
                encryptionMode: mode, metadata: mode === 'plain' ? '{}' : 'sealed-metadata',
                agentState: mode === 'plain' ? '{}' : 'sealed-state', createdAt: new Date(at),
                updatedAt: new Date(at), lastActiveAt: new Date(at) } });
            await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1,
                createdAt: new Date(at), updatedAt: new Date(at), content: mode === 'plain'
                    ? { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'x'.repeat(10_000) } } }
                    : { t: 'encrypted', c: 'x'.repeat(10_000) } } });
            if (live) await db.sessionTurn.create({ data: { sessionId: session.id, turnId: randomUUID(),
                status: 'in_progress', startedAt: BigInt(at), updatedAt: BigInt(at), lastMutationId: randomUUID() } });
            return session.id;
        };
        const old = await make(400), month = await make(30), week = await make(3), today = await make(0.1), live = await make(400, true);
        const periods = [['today', [today, live]], ['7days', [today, week, live]],
            ['90days', [today, week, month, live]], ['all', [today, week, month, old, live]]] as const;
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const hydrated: string[] = [];
            const stop = observeSqliteRequests({ after(request, rows) {
                if (request.model !== 'Session' || !Array.isArray(rows)) return;
                for (const row of rows) if (row && typeof row === 'object' && 'metadataVersion' in row
                    && 'agentStateVersion' in row && 'id' in row && typeof row.id === 'string') hydrated.push(row.id);
            } });
            try {
                const costs = [];
                const memberships = [];
                for (const [period, expected] of periods) {
                    hydrated.length = 0;
                    const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                        headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                        payload: { nowMs, requests: [{ query: normalizeUsageQuery({ period: { relative: period }, includeWorkEvidence: false }) }] } });
                    expect(response.statusCode).toBe(200);
                    const body = response.json();
                    costs.push({ period, selectedSessions: body.requests[0].sessionIds.length,
                        hydratedSessions: hydrated.length, httpBytes: response.rawPayload.byteLength });
                    memberships.push({ selected: body.requests[0].sessionIds.sort(), hydrated: [...hydrated].sort(), expected: [...expected].sort() });
                }
                console.log(JSON.stringify({ boundary: 'retained-unknown-http-demand', mode, costs }));
                for (const membership of memberships) {
                    expect(membership.selected).toEqual(membership.expected);
                    expect(membership.hydrated).toEqual(membership.expected);
                }
                expect(costs.map(cost => cost.selectedSessions)).toEqual([2, 3, 4, 5]);
                for (let index = 1; index < costs.length; index++) expect(costs[index].httpBytes).toBeGreaterThan(costs[index - 1].httpBytes);
            } finally { stop(); }
        });
    });

    it('keeps retained message corrections whose old parent activity did not advance', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
        const empty = { v: 1 as const, minMs: null, maxMs: null };
        const make = async (correctedAt: number) => {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
                encryptionMode: 'e2ee', metadata: 'sealed', createdAt: new Date(10),
                updatedAt: new Date(10), lastActiveAt: new Date(10),
                usageTimingV1: { v: 1, metadata: empty, agentState: empty } } });
            await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1,
                createdAt: new Date(10), updatedAt: new Date(correctedAt), content: { t: 'encrypted', c: 'sealed' } } });
            return session.id;
        };
        const corrected = await make(250);
        await make(10);
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                payload: { nowMs: 400, requests: [{ query: normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, includeWorkEvidence: false }) }] } });
            expect(response.statusCode).toBe(200);
            expect(response.json().requests[0].sessionIds).toEqual([corrected]);
        });
    });

    it.each(['plain', 'e2ee'] as const)('hydrates %s Today, 7-day, 90-day and All demand with proportional HTTP bytes', async mode => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: mode } });
        const nowMs = Date.UTC(2026, 10, 5, 12), day = 86_400_000;
        const empty = { v: 1 as const, minMs: null, maxMs: null };
        const publishTiming = async (sessionId: string, expectedVersion: number) => {
            expect(await inTx(tx => writeLegacySessionTupleInTx(tx, { sessionId,
                metadata: { ciphertext: mode === 'plain' ? '{"path":"/work/updated"}' : 'sealed-metadata-updated', expectedVersion },
                agentState: { ciphertext: mode === 'plain' ? '{}' : 'sealed-state', expectedVersion },
                usageTimingV1: projectUsageSessionTimingV1({ metadata: { path: '/work/updated' }, agentState: {} }) })))
                .toMatchObject({ ok: true, didWrite: true });
        };
        const make = async (at: number, known = false) => {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
                encryptionMode: mode, metadata: '{}', createdAt: new Date(nowMs - 500 * day) } });
            expect(await inTx(tx => writeLegacySessionTupleInTx(tx, { sessionId: session.id,
                metadata: { ciphertext: mode === 'plain' ? '{"path":"/work"}' : 'sealed-metadata', expectedVersion: 0 },
                agentState: { ciphertext: mode === 'plain' ? '{}' : 'sealed-state', expectedVersion: 0 },
                ...(known ? { usageTimingV1: projectUsageSessionTimingV1({ metadata: { path: '/work' }, agentState: {} }) } : {}) }))).toMatchObject({ ok: true });
            const message = await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1,
                createdAt: new Date(at), content: mode === 'plain'
                    ? { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'ordinary' } } }
                    : { t: 'encrypted', c: 'sealed-message' }, usageTimingV1: empty } });
            return { session, message };
        };
        const old = await make(nowMs - 400 * day), month = await make(nowMs - 10 * day), today = await make(nowMs - 3_600_000);
        const periods = [['today', [today.session.id]], ['7days', [today.session.id]], ['90days', [today.session.id, month.session.id]],
            ['all', [today.session.id, month.session.id, old.session.id]]] as const;
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const hydrated: string[] = [];
            const stop = observeSqliteRequests({ after(request, rows) {
                if (request.model !== 'Session' || !Array.isArray(rows)) return;
                for (const row of rows) if (row && typeof row === 'object' && 'metadataVersion' in row
                    && 'agentStateVersion' in row && 'id' in row && typeof row.id === 'string') hydrated.push(row.id);
            } });
            try {
                const read = async (period: typeof periods[number][0], expected: readonly string[]) => {
                    hydrated.length = 0;
                    const response = await app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                        headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                        payload: { nowMs, requests: [{ query: normalizeUsageQuery({ period: { relative: period }, includeWorkEvidence: false }) }] } });
                    expect(response.statusCode).toBe(200);
                    const body = response.json();
                    expect(body.requests[0].sessionIds.sort()).toEqual([...expected].sort());
                    expect(hydrated.sort()).toEqual([...expected].sort());
                    expect(body.results).toHaveLength(expected.length);
                    expect(body.results.every((row: { detail: { status: number } }) => row.detail.status === 200)).toBe(true);
                    return { period, selectedSessions: expected.length, hydratedSessions: hydrated.length,
                        httpBytes: response.rawPayload.byteLength, detailBytes: Buffer.byteLength(JSON.stringify(body.results.map((row: { detail: unknown }) => row.detail))) };
                };
                // Released writers leave private timing unknown. Normal writes
                // certify it lazily; no read or startup backfill is involved.
                const unknown = [];
                for (const [period] of periods) unknown.push(await read(period, [today.session.id, month.session.id, old.session.id]));
                for (const subject of [old, month, today]) await publishTiming(subject.session.id, 1);
                const before = [];
                for (const [period, expected] of periods) before.push(await read(period, expected));
                expect(before[0].httpBytes).toBeLessThan(before[2].httpBytes);
                expect(before[1].httpBytes).toBeLessThan(before[2].httpBytes);
                expect(before[2].httpBytes).toBeLessThan(before[3].httpBytes);
                // This known unrelated subject has no observation before any requested end.
                const unrelated = await make(nowMs + day, true);
                await db.sessionMessage.update({ where: { id: unrelated.message.id }, data: { content: mode === 'plain'
                    ? { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'x'.repeat(500_000) } } }
                    : { t: 'encrypted', c: 'x'.repeat(500_000) } } });
                const after = [];
                for (const [period, expected] of periods) after.push(await read(period, expected));
                expect(after).toEqual(before);
                console.log(JSON.stringify({ boundary: 'sqlite-usage-http-demand', mode, unknownCosts: unknown, costs: before, unrelatedBodyBytes: 500_000 }));
            } finally { stop(); }
        });
    });

    it('hydrates only known window subjects in both modes and keeps retained unknowns observable', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const timing = projectUsageSessionTimingV1({ metadata: {}, agentState: {} });
        const make = async (mode: 'plain' | 'e2ee', at: number) => {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
                encryptionMode: mode, metadata: '{}', createdAt: new Date(10) } });
            // The real content CAS, not an independent timing-only fixture write.
            expect(await inTx(tx => writeLegacySessionTupleInTx(tx, { sessionId: session.id,
                metadata: { ciphertext: mode === 'plain' ? '{"name":"subject"}' : 'sealed-metadata', expectedVersion: 0 },
                agentState: { ciphertext: mode === 'plain' ? '{}' : 'sealed-state', expectedVersion: 0 }, usageTimingV1: timing })))
                .toMatchObject({ ok: true });
            await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, createdAt: new Date(at),
                content: mode === 'plain' ? { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'ordinary' } } }
                    : { t: 'encrypted', c: 'sealed' }, usageTimingV1: { v: 1, minMs: null, maxMs: null } } });
            return session;
        };
        const inside = await make('plain', 250);
        const knownOutside = await make('e2ee', 100);
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 }, includeWorkEvidence: false });
        await withAuthenticatedTestApp(registerAccountUsageRoutes, async app => {
            const hydrated: string[] = [];
            const stop = observeSqliteRequests({ after(request, result) {
                if (request.model !== 'Session' || !Array.isArray(result)) return;
                for (const row of result) if (row && typeof row === 'object' && 'metadataVersion' in row
                    && 'agentStateVersion' in row && 'id' in row && typeof row.id === 'string') hydrated.push(row.id);
            } });
            try {
                const read = (sessionIds?: string[]) => app.inject({ method: 'POST', url: '/v2/usage/session-evidence',
                    headers: { 'x-test-user-id': owner.id, ...currentAccountStoredContentCompatibilityHeaders },
                    payload: { nowMs: 400, requests: [{ query, ...(sessionIds ? { sessionIds } : {}) }] } });
                const before = await read();
                expect(before.statusCode).toBe(200);
                expect(before.json().requests[0].sessionIds).toEqual([inside.id]);
                expect(hydrated).toEqual([inside.id]);
                // Neither unrelated inventory nor its opaque body is hydrated.
                for (let index = 0; index < 8; index++) await make(index % 2 ? 'e2ee' : 'plain', 100);
                await db.sessionMessage.updateMany({ where: { sessionId: knownOutside.id },
                    data: { content: { t: 'encrypted', c: 'x'.repeat(500_000) } } });
                hydrated.length = 0;
                const padded = await read();
                expect(padded.json()).toEqual(before.json());
                expect(Buffer.byteLength(padded.body)).toBe(Buffer.byteLength(before.body));
                expect(hydrated).toEqual([inside.id]);
                // A released writer changes protected content without proof.
                expect(await inTx(tx => writeLegacySessionTupleInTx(tx, { sessionId: knownOutside.id,
                    agentState: { ciphertext: 'changed-sealed-state', expectedVersion: 1 } }))).toMatchObject({ ok: true });
                hydrated.length = 0;
                const unknown = await read();
                expect(unknown.json().requests[0].sessionIds.sort()).toEqual([inside.id, knownOutside.id].sort());
                expect(hydrated.sort()).toEqual([inside.id, knownOutside.id].sort());
                // Explicit historical membership stays exact and skips the unrestricted census.
                hydrated.length = 0;
                const explicit = await read([knownOutside.id]);
                expect(explicit.json().requests[0].sessionIds).toEqual([knownOutside.id]);
                expect(hydrated).toEqual([knownOutside.id]);
            } finally { stop(); }
        });
    });
});
