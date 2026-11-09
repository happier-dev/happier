import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { db } from '@/storage/db';
import { captureReadSnapshot } from '@/storage/captureReadSnapshot';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { buildSessionAccessWhere, resolveEffectiveSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import { createSessionListScopeWhere, createSessionPersonalAttentionQueryInTx } from '@/app/session/personal/queries';
import { hasSessionTranscriptPublicationLiveFacts } from '@/app/session/sessionTranscriptPublicationPolicy';
import { createV2SessionCompactListRowSelect, getV2SessionListEffectiveActivityAt } from './rows';
import { findV2SessionListCandidatePage, decodeV2SessionListMeaningfulActivityCursor, V2_SESSION_LIST_ORDER_BY, type SessionListRowAdmission } from './page';
import { conjoinSessionListWhereInputs, createFilteredSessionListWhere, createSessionListScopeQueryBranches } from './query';
import { listSessionsForAccount } from './service';
import { createV2SessionListServerTiming } from './timing';
import { resolveV2SessionListCandidateWindowLimit } from './readLimits';

/** The response budget bounds examined candidates, not the exact relation. */
export async function verifyBoundedSessionQueryContinuation(): Promise<void> {
    const prefix = `query-continuation-${randomUUID()}`;
    const owner = await db.account.create({ data: { publicKey: prefix, encryptionMode: 'plain' } });
    const quietRows = resolveV2SessionListCandidateWindowLimit(false)
        + resolveV2SessionListCandidateWindowLimit(true) + 7;
    const ids = Array.from({ length: quietRows + 4 }, (_, index) => `${prefix}-${index.toString().padStart(4, '0')}`);
    const authentication = createPresentUserSessionAccessAuthentication();
    try {
        await db.session.createMany({ data: ids.map((id, index) => ({
            id, tag: id, accountId: owner.id, encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}',
            meaningfulActivityAt: new Date(100_000 - index), active: index >= quietRows,
        })) });
        const actual: string[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await listSessionsForAccount({ userId: owner.id, authentication,
                source: { kind: 'query', query: { v: 1, storage: 'active', scope: 'my_work',
                    attention: 'any', includeInactive: false, includeAttention: false,
                    audiences: [], tagIds: [], limit: 3, ...(cursor ? { cursor } : {}) } },
                rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({ headers: {} }) });
            expect(page).not.toBeNull();
            if (!page || !('hasNext' in page)) throw new Error('Expected a query page');
            if (!cursor) {
                expect(page.sessions).toHaveLength(0);
                expect(page.hasNext).toBe(true);
                expect(page.nextCursor).toEqual(expect.any(String));
            }
            actual.push(...page.sessions.map(row => row.id));
            cursor = page.hasNext ? page.nextCursor ?? undefined : undefined;
            if (cursor) {
                expect(seen.has(cursor)).toBe(false);
                seen.add(cursor);
            }
        } while (cursor);
        expect(actual).toEqual(ids.slice(quietRows));
    } finally {
        await db.session.deleteMany({ where: { accountId: owner.id } });
        await db.account.delete({ where: { id: owner.id } });
    }
}

/** Compare the paged reader with the original monolithic relation, including overlapping relevance and access. */
export async function verifySessionQueryEquivalence(): Promise<void> {
    const prefix = `query-equivalence-${randomUUID()}`;
    const [viewer, other] = await Promise.all([0, 1].map(index => db.account.create({ data: {
        publicKey: `${prefix}-${index}`, encryptionMode: 'plain',
    } })));
    const ids = Array.from({ length: 40 }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`);
    const authentication = createPresentUserSessionAccessAuthentication();
    try {
        await db.session.createMany({ data: ids.map((id, index) => ({
            id, tag: id, accountId: index % 3 === 0 ? viewer.id : other.id,
            responsibleAccountId: index % 4 === 0 ? viewer.id : null,
            metadata: '{}', encryptionMode: 'plain', seq: 3,
            currentStorageState: index % 4 < 2 ? 'hosted' : index % 4 === 2 ? 'snapshot_complete' : 'machine_only',
            materializationPublicationId: index % 4 === 2 ? 'complete' : null,
            materializedThroughSourceAt: index % 4 === 2 ? BigInt(10_000 + Math.floor(index / 2)) : null,
            publishedThroughServerSeq: index % 4 === 2 ? 3 : null,
            createdAt: new Date(10_000 + Math.floor(index / 2)),
            meaningfulActivityAt: index % 4 === 1 ? null : new Date(10_000 + Math.floor(index / 2)),
            active: index % 5 === 0, pendingPermissionRequestCount: index % 7 === 0 ? 1 : 0,
        })) });
        await db.sessionShare.createMany({ data: ids.flatMap((sessionId, index) => index % 3 !== 0 && index % 5 !== 4
            ? [{ sessionId, sharedByUserId: other.id, sharedWithUserId: viewer.id, accessLevel: 'edit' }] : []) });
        await db.accountSessionFollow.createMany({ data: ids.flatMap((sessionId, index) => index % 4 === 1
            ? [{ sessionId, accountId: viewer.id, following: true, hasPersistentFollow: true }] : []) });
        await db.sessionPin.createMany({ data: ids.flatMap((sessionId, index) => index % 4 === 2
            ? [{ sessionId, accountId: viewer.id }] : []) });
        await db.sessionAttentionStanding.createMany({ data: ids.flatMap((sessionId, index) => index % 4 === 3
            ? [{ sessionId, accountId: viewer.id, standing: true }] : []) });
        await db.accountSessionReadState.createMany({ data: ids.flatMap((sessionId, index) => index % 3 === 0
            ? [{ sessionId, accountId: viewer.id, lastViewedSessionSeq: index % 2 === 0 ? 0 : 3 }] : []) });

        await captureReadSnapshot(async tx => {
            const access = await resolveEffectiveSessionAccessWhere({ tx, accountId: viewer.id,
                capability: 'readTranscript', mode: 'effective_access_v1', authentication });
            const scopeWhere = await createSessionListScopeWhere({ tx, accountId: viewer.id, scope: 'my_work' });
            const attention = createSessionPersonalAttentionQueryInTx(tx, { accountId: viewer.id,
                qualifiedTeamIds: access.qualifiedTeamIds });
            for (const includeInactive of [true, false]) {
                const filters = { accountId: viewer.id,
                    query: { v: 1, storage: 'active', scope: 'my_work', attention: 'any', includeInactive,
                        audiences: [], tagIds: [], limit: 3, includeAttention: false } satisfies SessionListQueryV1,
                    scopeWhere, audienceWhere: {}, attentionWhere: attention.candidateWhere };
                const baseWhere = createFilteredSessionListWhere({ ...filters, accessWhere: access.where });
                const baseWhereBranches = createSessionListScopeQueryBranches(scopeWhere).map(branch =>
                    createFilteredSessionListWhere({ ...filters, scopeWhere: branch, accessWhere: access.where }));
                // This fixture has owner/direct grants (collective grants have
                // their own real-DB access suite). Preserve the former Account
                // relation predicates in the unbounded oracle, too.
                const originalWhere = createFilteredSessionListWhere({ ...filters, accessWhere: buildSessionAccessWhere({
                    mode: 'legacy_owner_or_direct', accountId: viewer.id, capability: 'readTranscript',
                }) });
                const admission: SessionListRowAdmission = async rows => {
                    if (includeInactive) return rows;
                    const attentionIds = new Set((await attention.admitRows(rows)).map(row => row.id));
                    return rows.filter(row => row.active && hasSessionTranscriptPublicationLiveFacts(row) || attentionIds.has(row.id));
                };
                const originalRows = await tx.session.findMany({ where: conjoinSessionListWhereInputs(originalWhere, { id: { in: ids } }),
                    select: createV2SessionCompactListRowSelect({ userId: viewer.id, mode: 'effective_access_v1',
                        collectiveAccessSnapshot: access.collectiveAccessSnapshot }) });
                const expected = [...await admission(originalRows)].sort((a, b) =>
                    getV2SessionListEffectiveActivityAt(b).getTime() - getV2SessionListEffectiveActivityAt(a).getTime()
                    || b.id.localeCompare(a.id)).map(row => row.id);
                const actual: string[] = [];
                let cursor: { sessionId: string; meaningfulActivityAt: number } | undefined;
                do {
                    const page = await findV2SessionListCandidatePage({ userId: viewer.id, orderBy: V2_SESSION_LIST_ORDER_BY,
                        limit: 3, cursor, rowAdmission: admission, source: { kind: 'effective', reader: tx,
                            baseWhere, baseWhereBranches, accessMode: 'effective_access_v1', collectiveAccessSnapshot: access.collectiveAccessSnapshot } });
                    actual.push(...page.rows.map(row => row.id));
                    expect(actual.length).toBeLessThanOrEqual(ids.length);
                    cursor = decodeV2SessionListMeaningfulActivityCursor(page.nextCursor) ?? undefined;
                } while (cursor);
                expect(actual).toEqual(expected);
                expect(actual.length).toBeGreaterThan(3);
            }
        });
        await db.account.update({ where: { id: viewer.id }, data: { status: 'suspended' } });
        await captureReadSnapshot(async tx => {
            const access = await resolveEffectiveSessionAccessWhere({ tx, accountId: viewer.id,
                capability: 'readTranscript', mode: 'effective_access_v1', authentication });
            expect(await tx.session.findMany({ where: access.where, select: { id: true } })).toEqual([]);
        });
    } finally {
        await db.session.deleteMany({ where: { id: { in: ids } } });
        await db.account.deleteMany({ where: { id: { in: [viewer.id, other.id] } } });
    }
}
