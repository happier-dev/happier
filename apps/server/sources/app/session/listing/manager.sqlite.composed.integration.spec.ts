import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    projectSessionAwarenessV1,
    readSessionAwarenessWorkStatusV1,
    SessionAwarenessProjectionV1Schema,
    readSessionManagerSessionIdV1,
    readSessionLiveManagedSessionCountV1,
    SessionManagedSessionsV1Schema,
} from '@happier-dev/protocol';

import { db } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { listSessionsForAccount } from "./service";
import { createV2SessionListServerTiming } from "./timing";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";
import { withSqliteReadSnapshot } from "@/storage/prisma";
import { setAccountFollowRule, removeAccountFollowRule } from '@/app/session/follow/accountFollowRuleService';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { writeSessionTranscriptMessageInTx } from '@/app/session/sessionTranscriptWrite';
import { inTx } from '@/storage/inTx';
import { applyViewerReadCursorOperation, initializeSessionOwnerReadStateInTx } from '@/app/session/personal/readState';

const authentication = createPresentUserSessionAccessAuthentication();

function managerEdgeData(sourceSessionId: string, destinationSessionId: string) {
    return { sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: sourceSessionId }), sourceSessionId, destinationSessionId, relation: 'manager', managerSourceSessionId: sourceSessionId,
        policyJson: JSON.stringify({ preset: 'important' }) };
}

describe("Manager listing (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-reports-list-", initAuth: false });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const create = () => db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{"v":1}', encryptionMode: "plain",
            metadataLayoutVersion: 1, ownerMetadata: '{"t":"plain","v":{"v":1}}',
        } });
        return { owner, lead: await create(), unrelated: await create(), create };
    }

    const list = (userId: string, underSessionId: string) => listSessionsForAccount({
        userId, authentication,
        source: { kind: "query", query: {
            v: 1, storage: "active", includeInactive: true, scope: "all_accessible", attention: "any",
            audiences: [], tagIds: [], limit: 50, underSessionId,
        } },
        rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
    });

    it('filters coordinator membership before pagination and drops it after the last rule or managed child is removed', async () => {
        const { owner, lead, unrelated, create } = await fixture();
        const ruleReceiver = await create();
        const child = await create();
        await db.session.update({ where: { id: unrelated.id }, data: {
            active: true, pendingPermissionRequestCount: 1, pendingRequestObservedAt: new Date(),
        } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(child.id, lead.id) });
        const saved = await setAccountFollowRule({ accountId: owner.id, authentication, ruleId: 'project-rule', mutation: {
            receiver: { kind: 'session', sessionId: ruleReceiver.id }, expectedVersion: -1,
            content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['home'] }), policy: { preset: 'important' } } },
        } });
        expect(saved.ok).toBe(true);
        const query = { v: 1 as const, storage: 'active' as const, includeInactive: true, scope: 'all_accessible' as const,
            attention: 'any' as const, audiences: [], tagIds: [], coordinator: 'coordinator' as const, limit: 1, includeAttention: true };
        const read = (cursor?: string) => listSessionsForAccount({ userId: owner.id, authentication,
            source: { kind: 'query', query: { ...query, ...(cursor ? { cursor } : {}) } },
            rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}) });
        const first = await read();
        expect(first?.sessions).toHaveLength(1);
        expect(first?.hasNext).toBe(true);
        const second = await read(first?.nextCursor ?? undefined);
        expect(second?.sessions).toHaveLength(1);
        expect(second?.hasNext).toBe(false);
        const rows = [...first!.sessions, ...second!.sessions];
        expect(rows.map(row => row.id).sort()).toEqual([lead.id, ruleReceiver.id].sort());
        expect(rows.find(row => row.id === ruleReceiver.id)).toMatchObject({ receivedRuleCount: 1 });
        expect(rows.some(row => row.id === unrelated.id)).toBe(false);
        expect((await removeAccountFollowRule({ accountId: owner.id, authentication, ruleId: 'project-rule',
            receiver: { kind: 'session', sessionId: ruleReceiver.id }, expectedVersion: 0 })).ok).toBe(true);
        expect((await read())?.sessions.map(row => row.id)).toEqual([lead.id]);
        await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: child.id, relation: 'manager' } });
        expect((await read())?.sessions).toEqual([]);
    });

    it('keeps another Account private rule membership unavailable on a shared Session', async () => {
        const { owner, lead } = await fixture();
        const { owner: viewer } = await fixture();
        await db.sessionShare.create({ data: { sessionId: lead.id, sharedByUserId: owner.id,
            sharedWithUserId: viewer.id, accessLevel: 'view' } });
        expect((await setAccountFollowRule({ accountId: owner.id, authentication, ruleId: 'private-rule', mutation: {
            receiver: { kind: 'session', sessionId: lead.id }, expectedVersion: -1,
            content: { t: 'plain', v: { v: 1, enabled: false, filter: normalizeSessionListFilterV1(), policy: { preset: 'quiet' } } },
        } })).ok).toBe(true);
        expect((await list(owner.id, lead.id))?.sessions[0]).toMatchObject({ receivedRuleCount: 1 });
        expect((await list(viewer.id, lead.id))?.sessions[0]).not.toHaveProperty('receivedRuleCount');
        await expect(listSessionsForAccount({ userId: viewer.id, authentication,
            source: { kind: 'query', query: { v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible',
                attention: 'any', audiences: [], tagIds: [], coordinator: 'coordinator', underSessionId: lead.id } },
            rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
        })).rejects.toMatchObject({ reason: 'coordinator' });
    });

    it('removes a manager-only coordinator when final admission revokes its last readable child', async () => {
        const { owner, lead } = await fixture();
        const foreign = await fixture();
        await db.session.update({ where: { id: foreign.lead.id }, data: { archivedAt: new Date() } });
        await db.sessionShare.create({ data: { sessionId: foreign.lead.id, sharedByUserId: foreign.owner.id,
            sharedWithUserId: owner.id, accessLevel: 'view' } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(foreign.lead.id, lead.id) });
        const read = () => listSessionsForAccount({ userId: owner.id, authentication,
            source: { kind: 'query', query: { v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible',
                attention: 'any', audiences: [], tagIds: [], coordinator: 'coordinator', underSessionId: lead.id } },
            rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
        });
        expect((await read())?.sessions.map(row => row.id)).toEqual([lead.id]);
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.session;
        const original = delegate.findMany.bind(delegate);
        let enter!: () => void;
        let resume!: () => void;
        const reached = new Promise<void>(resolve => { enter = resolve; });
        const release = new Promise<void>(resolve => { resume = resolve; });
        let reportReads = 0;
        Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                const rows = await original(...args);
                if (args[0]?.select?.runtimeActivityState && !args[0]?.select?.metadataVersion && ++reportReads === 2) {
                    enter(); await release;
                }
                return rows;
            } });
        const response = read();
        try {
            expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
            await db.sessionShare.delete({ where: { sessionId_sharedWithUserId: {
                sessionId: foreign.lead.id, sharedWithUserId: owner.id } } });
            resume();
            expect((await response)?.sessions).toEqual([]);
        } finally {
            resume(); await response;
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
        }
    });

    it('refreshes captured list capabilities after an Admin grant becomes View', async () => {
        const { owner: viewer } = await fixture();
        const { owner, lead } = await fixture();
        const share = await db.sessionShare.create({ data: { sessionId: lead.id, sharedByUserId: owner.id,
            sharedWithUserId: viewer.id, accessLevel: 'admin', canApprovePermissions: true } });
        expect((await list(viewer.id, lead.id))?.sessions[0]?.effectiveAccess).toMatchObject({ level: 'admin' });
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.session;
        const original = delegate.findMany.bind(delegate);
        let enter!: () => void;
        let resume!: () => void;
        const reached = new Promise<void>(resolve => { enter = resolve; });
        const release = new Promise<void>(resolve => { resume = resolve; });
        let paused = false;
        Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                const rows = await original(...args);
                if (!paused && args[0]?.select?.metadataVersion) { paused = true; enter(); await release; }
                return rows;
            } });
        const response = list(viewer.id, lead.id);
        try {
            expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
            await db.sessionShare.update({ where: { id: share.id }, data: { accessLevel: 'view', canApprovePermissions: false } });
            resume();
            const captured = await response;
            const current = (await list(viewer.id, lead.id))?.sessions[0];
            expect(current?.effectiveAccess).toMatchObject({ level: 'view', capabilities: { manageAccess: false } });
            expect(current?.share).toEqual({ accessLevel: 'view', canApprovePermissions: false });
            expect(captured?.sessions[0]?.effectiveAccess).toMatchObject({ level: 'view', capabilities: { manageAccess: false } });
            expect(captured?.sessions[0]?.share).toEqual({ accessLevel: 'view', canApprovePermissions: false });
        } finally {
            resume(); await response;
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
        }
    });

    it('redacts a revoked report contribution while preserving the readable lead captured detail', async () => {
        const { owner, lead } = await fixture();
        const foreign = await fixture();
        await db.sessionShare.create({ data: { sessionId: foreign.lead.id, sharedByUserId: foreign.owner.id,
            sharedWithUserId: owner.id, accessLevel: 'view' } });
        await db.session.update({ where: { id: foreign.lead.id }, data: { active: true,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: new Date() } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(foreign.lead.id, lead.id) });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async app => {
            const request = { method: 'GET' as const, url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`,
                headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' } };
            const warm = await app.inject(request);
            expect(warm.statusCode, warm.body).toBe(200);
            expect(warm.json().session).toMatchObject({ managedSessions: { total: 1, needsYou: 1 } });
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const delegate = reader.session;
            const original = delegate.findMany.bind(delegate);
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    const rows = await original(...args);
                    if (!paused && args[0]?.select?.runtimeActivityState && !args[0]?.select?.metadataVersion) {
                        paused = true; enter(); await release;
                    }
                    return rows;
                } });
            const response = app.inject(request);
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                await db.sessionShare.delete({ where: { sessionId_sharedWithUserId: {
                    sessionId: foreign.lead.id, sharedWithUserId: owner.id } } });
                resume();
                const captured = await response;
                const current = await app.inject(request);
                expect(current.statusCode, current.body).toBe(200);
                expect(current.json().session).toMatchObject({ id: lead.id, managedSessions: { total: 0, needsYou: 0 } });
                expect(captured.statusCode, captured.body).toBe(200);
                expect(captured.json().session).toMatchObject({ id: lead.id, managedSessions: { total: 0, needsYou: 0 } });
            } finally {
                resume(); await response;
                Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
            }
        });
    });

    it("restricts the public listing to a readable root instead of every accessible session", async () => {
        const { owner, lead, unrelated } = await fixture();
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.map((row) => row.id)).toEqual([lead.id]);
        expect(page?.sessions.map((row) => row.id)).not.toContain(unrelated.id);
    });

    it("publishes immutable step origin and depth from the same row in list and detail", async () => {
        const { owner, lead } = await fixture();
        await db.session.update({ where: { id: lead.id }, data: {
            originKind: "run_step", originRunId: "workflow-run", workDepth: 3,
        } });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions[0]).toMatchObject({ ownerAccountId: owner.id, origin: { kind: "run_step", runId: "workflow-run" }, workDepth: 3 });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async (app) => {
            const response = await app.inject({ method: "GET", url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`,
                headers: { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().session).toMatchObject({ ownerAccountId: owner.id, origin: { kind: "run_step", runId: "workflow-run" }, workDepth: 3 });
        });
    });

    it("does not disclose other readable sessions under an unreadable root", async () => {
        const { owner } = await fixture();
        const foreign = await fixture();
        const page = await list(owner.id, foreign.lead.id);
        expect(page?.sessions).toEqual([]);
    });

    it("includes nested readable reports without granting access to an unreadable child", async () => {
        const { owner, lead, unrelated, create } = await fixture();
        const child = await create();
        const grandchild = await create();
        const foreign = await fixture();
        const readableBehindForeign = await create();
        await db.sessionFollowEdge.createMany({ data: [
            managerEdgeData(child.id, lead.id),
            managerEdgeData(grandchild.id, child.id),
            managerEdgeData(foreign.lead.id, lead.id),
            managerEdgeData(readableBehindForeign.id, foreign.lead.id),
        ] });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.map((row) => row.id).sort()).toEqual([lead.id, child.id, grandchild.id, readableBehindForeign.id].sort());
        expect(page?.sessions.map((row) => row.id)).not.toContain(unrelated.id);
        expect(page?.sessions.find((row) => row.id === child.id)).toMatchObject({ manager: { sessionId: lead.id } });
        expect(page?.sessions.find((row) => row.id === lead.id)).toMatchObject({ managedSessions: { total: 1, working: 0, needsYou: 0, stalled: 0 } });
        expect(page?.sessions.find((row) => row.id === readableBehindForeign.id)).not.toHaveProperty("manager");
    });

    it("counts three completed of five live direct reports and their strongest state without unreadable lead facts", async () => {
        const { owner, lead, create } = await fixture();
        const working = await create();
        const needsYou = await create();
        const grandchild = await create();
        const completed = await Promise.all([create(), create(), create()]);
        const archived = await create();
        await db.session.updateMany({ where: { id: { in: [...completed.map(child => child.id), archived.id] } }, data: {
            active: true, latestTurnStatus: "completed", latestTurnStatusObservedAt: BigInt(Date.now()),
        } });
        await db.session.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
        await db.session.update({ where: { id: working.id }, data: { active: true, latestTurnStatus: "in_progress" } });
        await db.session.update({ where: { id: needsYou.id }, data: {
            active: true, pendingPermissionRequestCount: 1, pendingRequestObservedAt: new Date(),
        } });
        await db.sessionFollowEdge.createMany({ data: [
            managerEdgeData(working.id, lead.id),
            managerEdgeData(needsYou.id, lead.id),
            managerEdgeData(grandchild.id, working.id),
            ...completed.map(child => managerEdgeData(child.id, lead.id)),
            managerEdgeData(archived.id, lead.id),
        ] });
        const page = await list(owner.id, lead.id);
        const reports = page?.sessions.find((row) => row.id === lead.id)?.managedSessions;
        expect(reports).toEqual({ total: 6, archived: 1, finished: 3, working: 1, needsYou: 1,
            stalled: 0, attentionPrimary: "permission_required" });
        expect(SessionManagedSessionsV1Schema.safeParse(reports).success).toBe(true);
        expect(readSessionLiveManagedSessionCountV1(reports)).toBe(5);
        const foreign = await fixture();
        await db.sessionFollowEdge.create({ data: managerEdgeData(foreign.lead.id, lead.id) });
        const foreignPage = await list(foreign.owner.id, foreign.lead.id);
        expect(foreignPage?.sessions[0]).not.toHaveProperty("manager");
    });

    it('rolls unseen primary failure above permission without adding it to Needs you, then clears it through the existing cursor', async () => {
        const { owner, lead, create } = await fixture();
        const failed = await create();
        const permission = await create();
        // Approved 09B §4.2/L09B-I2: owner creation seeds a read baseline; absence stays quiet.
        await inTx(tx => initializeSessionOwnerReadStateInTx(tx, { accountId: owner.id, sessionId: failed.id }));
        await db.session.update({ where: { id: failed.id }, data: { active: true } });
        await db.session.update({ where: { id: permission.id }, data: { active: true,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: new Date() } });
        await db.sessionFollowEdge.createMany({ data: [managerEdgeData(failed.id, lead.id), managerEdgeData(permission.id, lead.id)] });
        const turnId = randomUUID();
        const base = { v: 1 as const, sessionId: failed.id, turnId };
        const observedAt = Date.now();
        expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: {
            ...base, action: 'begin', mutationId: randomUUID(), observedAt,
        } })).toMatchObject({ ok: true });
        const marker = await inTx(tx => writeSessionTranscriptMessageInTx(tx, {
            sessionId: failed.id, writeAuthority: 'hosted', sessionEncryptionMode: 'plain', storagePolicy: 'optional',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'turn_failed', id: turnId } } } },
            localId: `${turnId}:turn_failed`, sidechainId: null, messageRole: 'event', createdAt: new Date(observedAt + 1),
        }));
        if (!marker.ok) throw new Error('failure marker did not commit');
        expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: {
            ...base, action: 'append_transcript_anchors', mutationId: randomUUID(), observedAt: observedAt + 2,
            transcriptAnchors: { startSeqInclusive: marker.message.seq, endSeqInclusive: marker.message.seq, finalAssistantMessageSeq: null },
        } })).toMatchObject({ ok: true });
        expect(await applySessionTurnMutation({ actorUserId: owner.id, authentication, mutation: {
            ...base, action: 'fail', mutationId: randomUUID(), observedAt: observedAt + 3,
            issue: { v: 1, scope: 'primary_session', status: 'failed', code: 'test_failure', source: 'unknown', occurredAt: observedAt + 3 },
        } })).toMatchObject({ ok: true });
        await db.session.update({ where: { id: failed.id }, data: { active: false } });
        const reports = () => list(owner.id, lead.id).then(page => page?.sessions.find(row => row.id === lead.id)?.managedSessions);
        expect(await reports()).toMatchObject({ total: 2, finished: 0, needsYou: 1, attentionPrimary: 'failed' });
        await db.session.update({ where: { id: failed.id }, data: { archivedAt: new Date() } });
        expect(await reports()).toMatchObject({ total: 2, archived: 1, finished: 0, needsYou: 1, attentionPrimary: 'permission_required' });
        await db.session.update({ where: { id: failed.id }, data: { archivedAt: null } });
        expect(await reports()).toMatchObject({ archived: 0, needsYou: 1, attentionPrimary: 'failed' });
        expect(await applyViewerReadCursorOperation({ accountId: owner.id, sessionId: failed.id,
            operation: { kind: 'mark-read' }, authentication })).toMatchObject({ ok: true });
        expect(await reports()).toMatchObject({ total: 2, finished: 0, needsYou: 1, attentionPrimary: 'permission_required' });
        await db.session.update({ where: { id: failed.id }, data: { seq: marker.message.seq + 2 } });
        expect(await reports()).toMatchObject({ needsYou: 1, attentionPrimary: 'permission_required' });
    });

    it("projects the same direct-report facts through HTTP detail without widening cross-owner reads", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        const foreign = await fixture();
        await db.sessionFollowEdge.createMany({ data: [
            managerEdgeData(child.id, lead.id),
            managerEdgeData(foreign.lead.id, lead.id),
        ] });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async (app) => {
            const headers = { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" };
            const leadDetail = await app.inject({ method: "GET", url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`, headers });
            expect(leadDetail.statusCode, leadDetail.body).toBe(200);
            expect(leadDetail.json().session).toMatchObject({ managedSessions: { total: 1, working: 0, needsYou: 0, stalled: 0 } });
            const childDetail = await app.inject({ method: "GET", url: `/v2/sessions/${child.id}?accessProjectionVersion=1`, headers });
            expect(childDetail.statusCode, childDetail.body).toBe(200);
            expect(childDetail.json().session).toMatchObject({ manager: { sessionId: lead.id } });
            const deniedDetail = await app.inject({ method: "GET", url: `/v2/sessions/${foreign.lead.id}?accessProjectionVersion=1`, headers });
            expect(deniedDetail.statusCode).toBe(404);
        });
    });

    it("keeps supplemental pins and attention inside the subtree and counts reports outside a page", async () => {
        const { owner, lead, unrelated, create } = await fixture();
        const child = await create();
        await db.sessionFollowEdge.create({ data: managerEdgeData(child.id, lead.id) });
        await db.session.update({ where: { id: lead.id }, data: { meaningfulActivityAt: new Date(Date.now() + 1_000) } });
        await db.sessionPin.create({ data: { accountId: owner.id, sessionId: unrelated.id, sortKey: "0" } });
        await db.sessionAttentionStanding.create({ data: { accountId: owner.id, sessionId: unrelated.id, standing: true } });
        const page = await listSessionsForAccount({
            userId: owner.id, authentication,
            source: { kind: "query", query: {
                v: 1, storage: "active", includeInactive: true, scope: "all_accessible", attention: "any",
                audiences: [], tagIds: [], limit: 1, includeAttention: true, underSessionId: lead.id,
            } },
            rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
        });
        expect(page?.sessions.map((row) => row.id)).not.toContain(unrelated.id);
        expect(page?.sessions).toHaveLength(1);
        expect(page?.sessions[0]).toMatchObject({ id: lead.id, managedSessions: { total: 1 } });
    });

    it("counts an inactive report whose own latest turn is still in flight as stalled", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        await db.session.update({ where: { id: child.id }, data: {
            active: false, latestTurnStatus: "in_progress", latestTurnStatusObservedAt: BigInt(0),
            lastActiveAt: new Date(0),
        } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(child.id, lead.id) });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)).toMatchObject({ managedSessions: {
            total: 1, working: 0, needsYou: 0, stalled: 1,
        } });
    });

    it("does not count an inactive report with a completed turn as stalled", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        await db.session.update({ where: { id: child.id }, data: {
            active: false, latestTurnStatus: "completed", latestTurnStatusObservedAt: BigInt(Date.now()),
        } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(child.id, lead.id) });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)?.managedSessions)
            .toMatchObject({ total: 1, working: 0, needsYou: 0, stalled: 0, archived: 0, finished: 1 });
    });

    it('does not infer completed settlement from idle, detached, cancelled or failed reports', async () => {
        const { owner, lead, create } = await fixture();
        for (const latestTurnStatus of [null, 'waiting', 'cancelled', 'failed'] as const) {
            const child = await create();
            await db.session.update({ where: { id: child.id }, data: { active: false, latestTurnStatus } });
            await db.sessionFollowEdge.create({ data: managerEdgeData(child.id, lead.id) });
        }
        expect((await list(owner.id, lead.id))?.sessions.find(row => row.id === lead.id)?.managedSessions)
            .toMatchObject({ total: 4, archived: 0, working: 0, needsYou: 0, finished: 0 });
    });

    it("keeps an inactive failed report in Recent instead of counting Needs you", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        await db.session.update({ where: { id: child.id }, data: {
            active: false, latestTurnStatus: "failed", latestTurnStatusObservedAt: BigInt(Date.now()),
        } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(child.id, lead.id) });
        const expected = { total: 1, working: 0, needsYou: 0, stalled: 0, archived: 0, finished: 0 };
        expect((await list(owner.id, lead.id))?.sessions.find(row => row.id === lead.id)?.managedSessions).toMatchObject(expected);
        await withAuthenticatedTestApp(registerSessionListingRoutes, async app => {
            const response = await app.inject({ method: "GET", url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`,
                headers: { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "4" } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().session.managedSessions).toMatchObject(expected);
        });
        // Runtime detachment changes display classification, never the failed turn evidence.
        expect((await db.session.findUniqueOrThrow({ where: { id: child.id } })).latestTurnStatus).toBe('failed');
        await db.session.update({ where: { id: child.id }, data: { active: true, lastActiveAt: new Date() } });
        expect((await list(owner.id, lead.id))?.sessions.find(row => row.id === lead.id)?.managedSessions)
            .toMatchObject(expected);
        await db.session.update({ where: { id: child.id }, data: { archivedAt: new Date() } });
        expect((await list(owner.id, lead.id))?.sessions.find(row => row.id === lead.id)?.managedSessions).toMatchObject({ ...expected, archived: 1, attentionPrimary: null });
    });

    it("counts an active mid-turn report as working rather than stalled", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        await db.session.update({ where: { id: child.id }, data: {
            active: true, latestTurnStatus: "in_progress", latestTurnStatusObservedAt: BigInt(0),
            lastActiveAt: new Date(0),
        } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(child.id, lead.id) });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)?.managedSessions)
            .toMatchObject({ total: 1, working: 1, needsYou: 0, stalled: 0, archived: 0, finished: 0, attentionPrimary: 'thinking' });
    });

    it("omits a hidden stalled report from list and detail counts and ids", async () => {
        const { owner, lead, create } = await fixture();
        const child = await create();
        const foreign = await fixture();
        for (const sessionId of [child.id, foreign.lead.id]) {
            await db.session.update({ where: { id: sessionId }, data: { active: false, latestTurnStatus: "in_progress" } });
            await db.sessionFollowEdge.create({ data: managerEdgeData(sessionId, lead.id) });
        }
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.map((row) => row.id).sort()).toEqual([lead.id, child.id].sort());
        expect(page?.sessions.find((row) => row.id === lead.id)?.managedSessions)
            .toMatchObject({ total: 1, working: 0, needsYou: 0, stalled: 1, archived: 0, finished: 0 });
        await withAuthenticatedTestApp(registerSessionListingRoutes, async (app) => {
            const headers = { "x-test-user-id": owner.id, "x-happier-account-stored-content-protocol": "2" };
            const detail = await app.inject({ method: "GET", url: `/v2/sessions/${lead.id}?accessProjectionVersion=1`, headers });
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json().session.managedSessions).toMatchObject({ total: 1, working: 0, needsYou: 0, stalled: 1, archived: 0, finished: 0 });
            const denied = await app.inject({ method: "GET", url: `/v2/sessions/${foreign.lead.id}?accessProjectionVersion=1`, headers });
            expect(denied.statusCode).toBe(404);
        });
    });

    it("counts active reports with unknown presence by the shared operational buckets and suppresses unreadable reports", async () => {
        const { owner, lead, create } = await fixture();
        const primaries = ["failed", "permission_required", "action_required", "working", "ready"] as const;
        for (const primary of primaries) {
            const child = await create();
            await db.session.update({ where: { id: child.id }, data: {
                active: true,
                latestTurnStatus: primary === "failed" ? "failed" : primary === "working" ? "in_progress" : "completed",
                latestTurnStatusObservedAt: BigInt(Date.now()),
                pendingPermissionRequestCount: primary === "permission_required" ? 1 : 0,
                pendingUserActionRequestCount: primary === "action_required" ? 1 : 0,
                pendingRequestObservedAt: new Date(),
            } });
            await db.sessionFollowEdge.create({ data: managerEdgeData(child.id, lead.id) });
        }
        const foreign = await fixture();
        await db.session.update({ where: { id: foreign.lead.id }, data: { active: true, latestTurnStatus: "failed" } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(foreign.lead.id, lead.id) });
        const expected = { total: primaries.length, working: 1, needsYou: 2, stalled: 0, archived: 0, finished: 3, attentionPrimary: 'permission_required' };
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.find((row) => row.id === lead.id)?.managedSessions)
            .toEqual(expected);
        expect(page?.sessions.map((row) => row.id)).not.toContain(foreign.lead.id);
        const awareness = page!.sessions.map(row => SessionAwarenessProjectionV1Schema.parse(projectSessionAwarenessV1({
            nowMs: Date.now(), sessionId: row.id, origin: row.origin,
            manager: row.manager, managedSessions: row.managedSessions, pendingReviewRuns: row.pendingReviewRuns,
            lifecycle: { archivedAtMs: row.archivedAt, latestTurnStatus: row.latestTurnStatus,
                latestTurnStatusObservedAtMs: row.latestTurnStatusObservedAt,
                latestReadyEventSeq: row.latestReadyEventSeq, latestReadyEventAtMs: row.latestReadyEventAt },
            runtime: { presence: 'unknown', active: row.active, lastObservedAtMs: row.activeAt },
            pending: { hasPendingPermissionRequests: (row.pendingPermissionRequestCount ?? 0) > 0,
                hasPendingUserActionRequests: (row.pendingUserActionRequestCount ?? 0) > 0,
                pendingRequestObservedAtMs: row.pendingRequestObservedAt },
            content: { mode: 'plain' },
            currentness: { lifecycle: 'observed', runtime: 'observed', pending: 'observed' },
        })));
        expect(awareness.find(row => row.sessionId === lead.id)?.managedSessions).toEqual(expected);
        const reports = awareness.filter(row => readSessionManagerSessionIdV1(row) === lead.id);
        expect(reports).toHaveLength(expected.total);
        const statuses = reports.map(row => readSessionAwarenessWorkStatusV1({ awareness: { ...row,
            viewer: page!.sessions.find(session => session.id === row.sessionId)?.viewer } }));
        expect(statuses.filter(status => status.bucket === "working")).toHaveLength(expected.working);
        expect(statuses.filter(status => status.bucket === "needs_you")).toHaveLength(expected.needsYou);
    });

    it("does not disclose a shared report whose publication tuple is malformed", async () => {
        const { owner, lead } = await fixture();
        const foreign = await fixture();
        await db.session.update({ where: { id: foreign.lead.id }, data: {
            currentStorageState: "snapshot_complete", seq: 0, acceptedThroughServerSeq: 0,
            publishedThroughServerSeq: 0, materializedThroughSourceAt: BigInt(1),
            materializationPublicationId: "   ",
        } });
        await db.sessionShare.create({ data: {
            sessionId: foreign.lead.id, sharedByUserId: foreign.owner.id,
            sharedWithUserId: owner.id, accessLevel: "view",
        } });
        await db.sessionFollowEdge.create({ data: managerEdgeData(foreign.lead.id, lead.id) });
        const page = await list(owner.id, lead.id);
        expect(page?.sessions.map((row) => row.id)).toEqual([lead.id]);
        expect(page?.sessions[0]).toMatchObject({ managedSessions: { total: 0, working: 0, needsYou: 0, stalled: 0 } });
    });
});
