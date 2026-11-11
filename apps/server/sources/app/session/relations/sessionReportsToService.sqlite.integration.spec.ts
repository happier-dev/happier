import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareSessionFollowFrontierProgressV1 } from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { transitionSessionArchiveStateInTx } from '@/app/session/archive/transitionSessionArchiveStateInTx';
import { applySessionAccessTransitionEffectsInTx } from '@/app/session/access/sessionAccessTransitionEffects';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { removeUnsafeSessionManagerEdgesForAccessChangeInTx, setSessionManager, attachCreatedSessionManagerInTx } from '../follow/sessionManagerService';
import { getSessionAutoFollowPreferences, setSessionAutoFollowPreferences } from '../follow/accountFollowService';
import { attachDiscussionFollowSourceInTx } from '../follow/discussionFollowSource';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
const account = () => db.account.create({ data: { publicKey: `reports-${randomUUID()}`, encryptionMode: 'plain' } });
const session = (accountId: string, facts = {}) => db.session.create({ data: {
    accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', ...facts,
} });
const set = (accountId: string, sessionId: string, managerSessionId: string | null, expectedManagerSessionId: string | null = null) =>
    setSessionManager({ accountId, sessionId, managerSessionId, expectedManagerSessionId, authentication });

describe('SessionManager service (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-reports-to-' }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });
    afterEach(async () => {
        await db.session.deleteMany();
        await db.account.deleteMany();
        await db.homeSettings.deleteMany();
    });

    it('uses saved creation policies only for new attachments and preserves them on legacy preference writes', async () => {
        const owner = await account();
        const preferences = { assigned: true, direct: false, team: false, group: false };
        expect(await setSessionAutoFollowPreferences({ accountId: owner.id, preferences: {
            ...preferences, managerPolicy: { preset: 'quiet' }, runReportPolicy: { preset: 'everything' },
            discussionReceivePolicy: { preset: 'custom', events: { message: { delivery: 'quiet' } } },
        } })).toMatchObject({ ok: true });
        const [child, manager] = await Promise.all([session(owner.id), session(owner.id)]);
        const discussion = await db.discussion.create({ data: {
            ownerAccountId: owner.id, createdByAccountId: owner.id, encryptionMode: 'plain',
            dataEncryptionKey: Uint8Array.from(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
            anchorV1: { kind: 'session', sessionId: child.id }, anchorSessionId: child.id,
            creationLocalId: randomUUID(), creationEqualityEvidenceV1: { kind: 'plainDigest', digest: randomUUID() },
            titleContent: { t: 'plain', v: { v: 1, title: 'Creation defaults' } },
            lastMessageAt: new Date(),
        } });
        await inTx(tx => attachDiscussionFollowSourceInTx(tx, { discussionId: discussion.id, destinationSessionId: manager.id }));
        const readDiscussionPolicy = async () => JSON.parse((await db.sessionFollowEdge.findUniqueOrThrow({
            where: { destinationSessionId_sourceDiscussionId_relation: { destinationSessionId: manager.id, sourceDiscussionId: discussion.id, relation: 'follower' } },
        })).policyJson);
        expect(await readDiscussionPolicy()).toEqual({ preset: 'custom', events: { message: { delivery: 'quiet' } } });
        expect((await set(owner.id, child.id, manager.id)).ok).toBe(true);
        const readPolicy = async () => JSON.parse((await db.sessionFollowEdge.findUniqueOrThrow({
            where: { managerSourceSessionId: child.id },
        })).policyJson);
        expect(await readPolicy()).toEqual({ preset: 'quiet' });
        expect(await setSessionAutoFollowPreferences({ accountId: owner.id, preferences: { ...preferences, managerPolicy: { preset: 'everything' } } }))
            .toMatchObject({ ok: true });
        expect(await readPolicy()).toEqual({ preset: 'quiet' });
        expect((await set(owner.id, child.id, manager.id, manager.id)).ok).toBe(true);
        expect(await readPolicy()).toEqual({ preset: 'quiet' });
        await setSessionAutoFollowPreferences({ accountId: owner.id, preferences: { ...preferences, assigned: false } });
        expect(await getSessionAutoFollowPreferences({ accountId: owner.id })).toMatchObject({ ok: true, value: {
            assigned: false, managerPolicy: { preset: 'everything' }, runReportPolicy: { preset: 'everything' },
            discussionReceivePolicy: { preset: 'custom', events: { message: { delivery: 'quiet' } } },
        } });
        await setSessionAutoFollowPreferences({ accountId: owner.id, preferences: { ...preferences, discussionReceivePolicy: { preset: 'everything' } } });
        await inTx(tx => attachDiscussionFollowSourceInTx(tx, { discussionId: discussion.id, destinationSessionId: manager.id }));
        expect(await readDiscussionPolicy()).toEqual({ preset: 'custom', events: { message: { delivery: 'quiet' } } });
        await set(owner.id, child.id, null, manager.id);
        await set(owner.id, child.id, manager.id);
        expect(await readPolicy()).toEqual({ preset: 'everything' });
    });

    it('stores manager and independently configured follower intent together, preserving follower on detach', async () => {
        const owner = await account();
        const [child, manager] = await Promise.all([session(owner.id), session(owner.id)]);
        await db.sessionFollowEdge.create({ data: {
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: child.id }),
            sourceSessionId: child.id, destinationSessionId: manager.id, policyJson: '{"preset":"quiet"}',
        } });
        expect((await set(owner.id, child.id, manager.id)).ok).toBe(true);
        expect(await db.sessionFollowEdge.count({ where: { sourceSessionId: child.id, destinationSessionId: manager.id } })).toBe(2);
        expect((await set(owner.id, child.id, null, manager.id)).ok).toBe(true);
        expect(await db.sessionFollowEdge.count({ where: { sourceSessionId: child.id, destinationSessionId: manager.id } })).toBe(1);
    });

    it('attaches, reparents and detaches with a state CAS and idempotent same-parent retry', async () => {
        const owner = await account();
        const [child, first, second] = await Promise.all([session(owner.id), session(owner.id), session(owner.id)]);
        expect(await set(owner.id, child.id, first.id)).toMatchObject({ ok: true, managerSessionId: first.id });
        const initial = await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: child.id } });
        expect(await set(owner.id, child.id, first.id, first.id)).toMatchObject({ ok: true, attachedAt: initial.attachedAt.getTime() });
        expect(await set(owner.id, child.id, second.id)).toEqual({ ok: false, error: 'manager_cas_conflict' });
        expect(await set(owner.id, child.id, second.id, first.id)).toMatchObject({ ok: true, managerSessionId: second.id });
        expect(await set(owner.id, child.id, null, first.id)).toEqual({ ok: false, error: 'manager_cas_conflict' });
        expect(await set(owner.id, child.id, null, second.id)).toMatchObject({ ok: true, managerSessionId: null, attachedAt: null });
        expect(await db.sessionFollowEdge.count({ where: { relation: 'manager' } })).toBe(0);
    });

    it('keeps every descendant edge when a parent is moved', async () => {
        const owner = await account();
        const [child, grandchild, first, second] = await Promise.all([
            session(owner.id), session(owner.id), session(owner.id), session(owner.id),
        ]);
        expect((await set(owner.id, child.id, first.id)).ok).toBe(true);
        expect((await set(owner.id, grandchild.id, child.id)).ok).toBe(true);

        expect((await set(owner.id, child.id, second.id, first.id)).ok).toBe(true);
        expect(await db.sessionFollowEdge.findMany({
            where: { relation: 'manager', sourceSessionId: { in: [child.id, grandchild.id] } },
            select: { sourceSessionId: true, destinationSessionId: true },
            orderBy: { sourceSessionId: 'asc' },
        })).toEqual([
            { sourceSessionId: child.id, destinationSessionId: second.id },
            { sourceSessionId: grandchild.id, destinationSessionId: child.id },
        ].sort((left, right) => left.sourceSessionId < right.sourceSessionId ? -1 : 1));
    });

    it('rejects self and ancestor cycles without changing the existing tree', async () => {
        const owner = await account();
        const [root, middle, leaf] = await Promise.all([session(owner.id), session(owner.id), session(owner.id)]);
        expect(await set(owner.id, root.id, root.id)).toEqual({ ok: false, error: 'manager_cycle' });
        expect((await set(owner.id, middle.id, root.id)).ok).toBe(true);
        expect((await set(owner.id, leaf.id, middle.id)).ok).toBe(true);
        expect(await set(owner.id, root.id, leaf.id)).toEqual({ ok: false, error: 'manager_cycle' });
        expect(await db.sessionFollowEdge.count({ where: { relation: 'manager' } })).toBe(2);
    });

    it('separates A-to-B-to-A and detach-to-A attachments even within one clock tick', async () => {
        const owner = await account();
        const [child, first, second] = await Promise.all([session(owner.id), session(owner.id), session(owner.id)]);
        // Clock is a genuine system boundary; all relation and persistence logic stays real.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(child.updatedAt.getTime());
        try {
            const initial = await set(owner.id, child.id, first.id);
            const moved = await set(owner.id, child.id, second.id, first.id);
            const returned = await set(owner.id, child.id, first.id, second.id);
            await set(owner.id, child.id, null, first.id);
            const reattached = await set(owner.id, child.id, first.id);
            if (!initial.ok || !moved.ok || !returned.ok || !reattached.ok) throw new Error('Attachment fixture was refused');
            expect(initial.attachedAt).not.toBeNull();
            expect(moved.attachedAt!).toBeGreaterThan(initial.attachedAt!);
            expect(returned.attachedAt!).toBeGreaterThan(moved.attachedAt!);
            expect(reattached.attachedAt!).toBeGreaterThan(returned.attachedAt!);
        } finally { clock.mockRestore(); }
    });

    it('requires active acting Account and read/input on both sides before the pairwise audience check', async () => {
        const [owner, actor] = await Promise.all([account(), account()]);
        const [child, lead] = await Promise.all([session(owner.id), session(owner.id)]);
        expect(await set(actor.id, child.id, lead.id)).toEqual({ ok: false, error: 'manager_forbidden', reason: 'read' });
        for (const target of [child, lead]) await db.sessionShare.create({ data: {
            sessionId: target.id, sharedByUserId: owner.id, sharedWithUserId: actor.id, accessLevel: 'view',
        } });
        expect(await set(actor.id, child.id, lead.id)).toEqual({ ok: false, error: 'manager_forbidden', reason: 'input' });
        await db.sessionShare.updateMany({ data: { accessLevel: 'edit' } });
        await db.account.update({ where: { id: actor.id }, data: { status: 'disabled' } });
        expect(await set(actor.id, child.id, lead.id)).toEqual({ ok: false, error: 'manager_forbidden', reason: 'read' });
        expect(await db.sessionFollowEdge.count({ where: { relation: 'manager' } })).toBe(0);
    });

    it('permits a cross-owner pair only when the whole lead audience can read the child', async () => {
        const [workerOwner, leadOwner, other] = await Promise.all([account(), account(), account()]);
        const child = await session(workerOwner.id);
        const lead = await session(leadOwner.id);
        await db.sessionShare.create({ data: { sessionId: lead.id, sharedByUserId: leadOwner.id, sharedWithUserId: workerOwner.id, accessLevel: 'edit' } });
        expect(await set(workerOwner.id, child.id, lead.id)).toEqual({ ok: false, error: 'manager_forbidden', reason: 'pairwise' });
        await db.sessionShare.create({ data: { sessionId: child.id, sharedByUserId: workerOwner.id, sharedWithUserId: leadOwner.id, accessLevel: 'edit' } });
        expect((await set(workerOwner.id, child.id, lead.id)).ok).toBe(true);
        expect(await inTx((tx) => removeUnsafeSessionManagerEdgesForAccessChangeInTx(tx, { sessionId: lead.id }))).toBe(0);
        await inTx(async (tx) => {
            const before = await resolveEffectiveSessionAccess(tx, { accountId: other.id, sessionId: lead.id, authentication });
            await tx.sessionShare.create({ data: { sessionId: lead.id, sharedByUserId: leadOwner.id, sharedWithUserId: other.id, accessLevel: 'view' } });
            const after = await resolveEffectiveSessionAccess(tx, { accountId: other.id, sessionId: lead.id, authentication });
            await applySessionAccessTransitionEffectsInTx(tx, {
                sessionId: lead.id, before: new Map([[other.id, before]]), after: new Map([[other.id, after]]),
            });
        });
        expect(await db.sessionFollowEdge.count({ where: { relation: 'manager' } })).toBe(0);
    });

    it('seeds before current terminal state, retries without reseeding delivered state, and reseeds on restore', async () => {
        const owner = await account();
        const child = await session(owner.id, { seq: 10, latestReadyEventSeq: 3, agentStateVersion: 4, latestTurnId: 'turn-terminal', latestTurnStatus: 'completed' });
        const lead = await session(owner.id);
        expect((await set(owner.id, child.id, lead.id)).ok).toBe(true);
        const edge = await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: child.id } });
        // The stored frontier leaves current terminal facts pending, without replaying prior transcript.
        expect(edge.deliveredTranscriptSeq).toBe(10);
        expect(edge.deliveredTurnId).toBeNull();
        expect(compareSessionFollowFrontierProgressV1({ transcriptSeq: edge.deliveredTranscriptSeq, readyEventSeq: edge.deliveredReadyEventSeq,
            agentStateVersion: edge.deliveredAgentStateVersion, turn: null },
        { transcriptSeq: 10, readyEventSeq: 3, agentStateVersion: 4, turn: { id: 'turn-terminal', status: 'completed' } })).toBe('ahead');
        await db.sessionFollowEdge.update({ where: { managerSourceSessionId: child.id }, data: {
            deliveredReadyEventSeq: 3, deliveredAgentStateVersion: 4, deliveredTurnId: 'turn-terminal', deliveredTurnStatus: 'completed',
        } });
        await set(owner.id, child.id, lead.id, lead.id);
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: child.id } })).deliveredTurnId).toBe('turn-terminal');
        await inTx((tx) => transitionSessionArchiveStateInTx({ tx, sessionId: lead.id, wasArchived: false, archivedAt: new Date() }));
        expect(await db.sessionFollowEdge.count({ where: { relation: 'manager' } })).toBe(1);
        expect((await db.session.findUniqueOrThrow({ where: { id: child.id } })).archivedAt).toBeNull();
        await inTx((tx) => transitionSessionArchiveStateInTx({ tx, sessionId: lead.id, wasArchived: true, archivedAt: null }));
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: child.id } })).deliveredTurnId).toBeNull();
    });

    it('allows attach to an archived session and retains its relation for restore', async () => {
        const owner = await account();
        const child = await session(owner.id);
        const lead = await session(owner.id, { archivedAt: new Date() });
        expect((await set(owner.id, child.id, lead.id)).ok).toBe(true);
        expect(await db.sessionFollowEdge.count({ where: { relation: 'manager' } })).toBe(1);
    });

    it('attaches a fresh child inside its creation transaction without allocating the Home fence', async () => {
        const owner = await account();
        const lead = await session(owner.id);
        const childId = await inTx(async (tx) => {
            const child = await tx.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            const result = await attachCreatedSessionManagerInTx(tx, { accountId: owner.id, sessionId: child.id, managerSessionId: lead.id, authentication });
            expect(result.ok).toBe(true);
            return child.id;
        });
        expect(await db.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: childId } })).not.toBeNull();
        expect(await db.homeSettings.count()).toBe(0);
    });
});
