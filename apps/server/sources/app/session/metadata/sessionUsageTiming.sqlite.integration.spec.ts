import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { writeLegacySessionTupleInTx } from './writeLegacySessionTuple';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readSessionEvidenceCandidateIdsInTx, selectSessionEvidenceSubjectsInTx } from '@/app/usage/query/selectSessionEvidenceSubjects';
import type { UsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPlainSessionOwnerMetadataEnvelopeV1, encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { updateSessionMetadataEnvelopeTuple } from '@/app/session/sessionWriteService';
import { writeSessionTranscriptMessageInTx } from '@/app/session/sessionTranscriptWrite';
import { updateSessionMessageAtCurrentRevisionInTx } from '@/app/session/sessionMessageRevisionWrite';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { commitSessionAgentCurrentView } from '@/app/session/agentTransition/commitSessionAgentCurrentView';

describe('Session timing grants the content CAS', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'session-usage-timing-',
        initAuth: false, initFiles: false }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('stores the authored legacy transition timing through the existing current-view CAS', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain',
            active: false, metadata: '{}', agentState: '{}' } });
        const empty = { v: 1 as const, minMs: null, maxMs: null };
        const timing = { v: 1 as const, metadata: { v: 1 as const, minMs: 100, maxMs: 250 }, agentState: empty };
        const currentView = { kind: 'legacy_v0' as const, expectedMetadataVersion: 0, metadataCiphertext: '{"agent":"codex"}',
            expectedAgentStateVersion: 0, agentStateCiphertext: null, usageTimingV1: timing };
        expect(await commitSessionAgentCurrentView({ actorUserId: account.id, sessionId: session.id, currentView })).toMatchObject({ ok: true });
        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).usageTimingV1).toEqual(timing);
    });

    it('selects known encrypted timing and retained unknowns without opening their content', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const empty = { v: 1 as const, minMs: null, maxMs: null };
        const outside = { v: 1 as const, minMs: 10, maxMs: 20 };
        const create = (timing: UsageSessionTimingV1 | null) => db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode: 'e2ee', metadata: 'opaque', agentState: 'opaque',
            ...(timing ? { usageTimingV1: timing } : {}) } });
        const knownOutside = await create({ v: 1, metadata: outside, agentState: empty });
        const overlappingWait = await create({ v: 1, metadata: empty, agentState: { v: 1, minMs: 100, maxMs: null } });
        const embedded = await create({ v: 1, metadata: empty, agentState: empty });
        await db.sessionMessage.create({ data: { sessionId: embedded.id, seq: 1, createdAt: new Date(10),
            content: { t: 'encrypted', c: 'opaque' }, usageTimingV1: { v: 1, minMs: 250, maxMs: 250 } } });
        const legacyUnknown = await create(null);
        const managed = await create({ v: 1, metadata: outside, agentState: empty });
        await db.sessionFollowEdge.create({ data: { sourceSessionId: managed.id, destinationSessionId: knownOutside.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: managed.id }), relation: 'manager',
            managerSourceSessionId: managed.id, policyJson: JSON.stringify({ preset: 'important' }) } });
        const ids = [knownOutside.id, overlappingWait.id, embedded.id, legacyUnknown.id, managed.id];
        const selected = await inTx(tx => selectSessionEvidenceSubjectsInTx(tx, { accountId: account.id, candidateIds: ids,
            query: normalizeUsageQuery({ period: { startMs: 200, endMs: 400 } }), nowMs: 400 }));
        expect(selected.sort()).toEqual([overlappingWait.id, embedded.id, legacyUnknown.id, managed.id].sort());
    });

    it('keeps recipient membership independent of private owner timing while owners still prune', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const empty = { v: 1 as const, minMs: null, maxMs: null };
        const bounds = [empty, { v: 1 as const, minMs: 10, maxMs: 20 }, { v: 1 as const, minMs: 250, maxMs: 250 }];
        const sessions = [];
        for (const component of bounds) {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
                metadata: '{}', agentState: '{}', updatedAt: new Date(100), lastActiveAt: new Date(100),
                usageTimingV1: { v: 1, metadata: component, agentState: component } } });
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
                accountId: recipient.id, accessLevel: 'view', canApprovePermissions: false } });
            await db.accountSessionFollow.create({ data: { accountId: recipient.id, sessionId: session.id } });
            sessions.push(session);
        }
        const query = normalizeUsageQuery({ period: { startMs: 200, endMs: 400 } });
        const select = (accountId: string) => inTx(async tx => {
            const candidateIds = await readSessionEvidenceCandidateIdsInTx(tx, {
                accountId, authentication: createPresentUserSessionAccessAuthentication(),
            });
            return selectSessionEvidenceSubjectsInTx(tx, { accountId, candidateIds, query, nowMs: 400 });
        });
        expect((await select(owner.id)).sort()).toEqual([sessions[2].id]);
        expect((await select(recipient.id)).sort()).toEqual(sessions.map(session => session.id).sort());
    });

    it.each(['plain', 'e2ee'] as const)('keeps %s owner timing private from a shared editor and atomic with the tuple CAS', async mode => {
        const owner = await db.account.create({ data: mode === 'plain' ? { encryptionMode: mode }
            : { encryptionMode: mode, ...createSignedAccountContentBinding() } });
        const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerMetadata = mode === 'plain' ? createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 })
            : sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: { v: 1 }, material: { type: 'legacy', secret: randomBytes(32) }, randomBytes });
        const shared = (version: number) => mode === 'plain' ? JSON.stringify({ v: 1, summary: { text: `name-${version}`, updatedAt: version } }) : `opaque-${version}`;
        const state = (version: number) => mode === 'plain' ? JSON.stringify({ controlledByUser: version > 0 }) : `opaque-state-${version}`;
        const bounds = { v: 1 as const, minMs: 100, maxMs: 250 };
        const timing = { v: 1 as const, metadata: bounds, agentState: bounds };
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: mode,
            active: true, metadataLayoutVersion: 1, metadata: shared(0), ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(ownerMetadata), agentState: state(0) } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const ownerPatch = { actorUserId: owner.id, sessionId: session.id, mode: 'owner' as const, metadataLayoutVersion: 1 as const, authentication,
            expectedOwnerMetadata: ownerMetadata, ownerMetadata, sharedMetadata: { ciphertext: shared(1), expectedVersion: 0 },
            agentState: { ciphertext: state(1), expectedVersion: 0 }, usageTimingV1: timing };
        expect(await updateSessionMetadataEnvelopeTuple(ownerPatch)).toMatchObject({ ok: true });
        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).usageTimingV1).toEqual(timing);
        expect((await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
            accountId: owner.id, kind: 'session', entityId: session.id,
        } } })).hint).toMatchObject({ memoryLocalityChanged: false, transcriptSeq: 0 });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: editor.id,
            accessLevel: 'edit', canApprovePermissions: false } });
        await db.accountSessionFollow.create({ data: { accountId: editor.id, sessionId: session.id } });
        const empty = { v: 1 as const, minMs: null, maxMs: null };
        expect(await updateSessionMetadataEnvelopeTuple({ actorUserId: editor.id, sessionId: session.id, mode: 'shared_editor',
            metadataLayoutVersion: 1, authentication, sharedMetadata: { ciphertext: shared(2), expectedVersion: 1 },
            usageTimingV1: { v: 1, metadata: empty, agentState: empty } })).toMatchObject({ ok: true });
        const afterShared = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(afterShared.usageTimingV1).toEqual({ ...timing, metadata: null });
        expect(await updateSessionMetadataEnvelopeTuple({ ...ownerPatch, sharedMetadata: { ciphertext: shared(3), expectedVersion: 0 } }))
            .toMatchObject({ ok: false, error: 'version-mismatch' });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(afterShared);
    });

    it.each(['plain', 'e2ee'] as const)('stores %s message timing and makes an old-writer correction unknown', async mode => {
        const owner = await db.account.create({ data: { encryptionMode: mode } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: mode, metadata: '{}' } });
        const content = mode === 'plain' ? { t: 'plain' as const, v: { role: 'agent', content: { type: 'text', text: 'body' } } }
            : { t: 'encrypted' as const, c: 'opaque' };
        const bounds = { v: 1 as const, minMs: 100, maxMs: 250 };
        const written = await inTx(tx => writeSessionTranscriptMessageInTx(tx, { sessionId: session.id,
            writeAuthority: 'hosted', sessionEncryptionMode: mode, storagePolicy: 'optional', localId: randomUUID(),
            sidechainId: null, messageRole: 'agent', content, usageTimingV1: bounds }));
        expect(written).toMatchObject({ ok: true });
        if (!written.ok) throw new Error('message write failed');
        const stored = await db.sessionMessage.findUniqueOrThrow({ where: { id: written.message.id } });
        expect(stored.usageTimingV1).toEqual(bounds);
        await inTx(tx => updateSessionMessageAtCurrentRevisionInTx({ tx, id: stored.id, rowRevision: stored.rowRevision,
            data: { rowRevision: { increment: BigInt(1) }, content: mode === 'plain' ? { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'corrected' } } }
                : { t: 'encrypted', c: 'corrected-opaque' } } }));
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: stored.id } })).usageTimingV1).toBeNull();
    });

    it.each(['plain', 'e2ee'] as const)('stores timing with %s content and invalidates only a changed source from an old writer', async encryptionMode => {
        const account = await db.account.create({ data: { encryptionMode } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode, metadata: '{}', agentState: '{}' } });
        const bounds = { v: 1 as const, minMs: 100, maxMs: 250 };
        const timing = { v: 1 as const, metadata: bounds, agentState: bounds };
        const write = (input: Record<string, unknown>) => inTx(tx => writeLegacySessionTupleInTx(tx, {
            sessionId: session.id, ...input,
        }));
        const read = async () => (await db.$queryRawUnsafe<Array<{ usageTimingV1: unknown }>>(
            'SELECT "usageTimingV1" FROM "Session" WHERE id = ?', session.id))[0].usageTimingV1;
        const decoded = async () => { const value = await read(); return typeof value === 'string' ? JSON.parse(value) : value; };
        expect(await write({ metadata: { ciphertext: '{"changed":1}', expectedVersion: 0 },
            agentState: { ciphertext: '{"changed":1}', expectedVersion: 0 }, usageTimingV1: timing })).toMatchObject({ ok: true });
        expect(await decoded()).toEqual(timing);
        expect(await write({ metadata: { ciphertext: '{"changed":1}', expectedVersion: 1 } })).toMatchObject({ ok: true, didWrite: false });
        expect(await decoded()).toEqual(timing);
        expect(await write({ metadata: { ciphertext: '{"changed":2}', expectedVersion: 1 } })).toMatchObject({ ok: true });
        expect(await decoded()).toEqual({ ...timing, metadata: null });
        const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(await write({ agentState: { ciphertext: '{"changed":2}', expectedVersion: 0 }, usageTimingV1: timing }))
            .toMatchObject({ ok: false, error: 'version-mismatch' });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(before);
    });
});
