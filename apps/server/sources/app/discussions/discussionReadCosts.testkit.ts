import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { db } from '@/storage/db';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import * as storage from '@/storage/prisma';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { archiveDiscussion, createDiscussion, postDiscussionMessage, restoreDiscussion } from './mutations';
import { listDiscussions, readDiscussionMessages } from './queries';
import { readDiscussionAttention } from './attentionFacts';
import { resolveDiscussionDocSourcesInTx, type DiscussionDocSource } from './docPassages';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { executeDocReadV1 } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { DiscussionListInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionTitleV1Schema, DiscussionProducerV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import { DiscussionReplyTargetV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import { DiscussionMessageAddressingV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DocEditProposalDispositionV1Schema } from '@happier-dev/protocol/discussions/models';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { encodeDiscussionListCursorV1 } from './pagination';
import { listDiscussionParticipants } from './accessService';
import { loadDiscussionKnownAccountActorFactsInTx } from './projection';
import { admitDiscussionQuoteSourcesInTx, discussionQuoteSourceKey, type DiscussionQuoteSource } from './quoteReadAdmission';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { DISCUSSION_DEFAULT_PAGE_SIZE_V1 } from '@happier-dev/protocol/discussions/api';
import type { DiscussionResult } from './serviceTypes';

const authentication = createPresentUserSessionAccessAuthentication();
const body = { t: 'plain' as const, v: { v: 1, parts: [{ t: 'text', text: 'Message' }] } };
const evidence = { kind: 'plainDigest', digest: 'A'.repeat(43) };
const fixtureAccountIds: string[] = [];

/** Observe only the real DB transport. All queries, admission and projection execute unchanged. */
async function measure<T>(run: () => Promise<T>) {
    const reads: Array<{ model: string; rows: number }> = [];
    let transactions = 0;
    const observeQuery = (query: unknown, record: (result: unknown) => void) => observeLazyPrismaQuery(query,
        () => ({ started() {}, settled() {} }), undefined, async consume => {
            const result = await consume();
            record(result);
            return result;
        });
    const observe = (tx: Tx): Tx => new Proxy(tx, {
        get(target, property, receiver) {
            const delegate: unknown = Reflect.get(target, property, receiver);
            if ((property === '$queryRaw' || property === '$queryRawUnsafe') && typeof delegate === 'function') {
                return (...args: unknown[]) => observeQuery(Reflect.apply(delegate, target, args), result => {
                    // Transaction deadline probes are not resource reads.
                    const text = typeof args[0] === 'string' ? args[0] : String(Reflect.get(args[0] as object, 'sql'));
                    if (/Discussion/.test(text)) reads.push({ model: /WITH RECURSIVE/.test(text) ? 'ancestors' : 'raw', rows: Array.isArray(result) ? result.length : 0 });
                });
            }
            if (typeof delegate === 'function') return delegate.bind(target);
            if ((!String(property).startsWith('discussion') && !['artifact', 'publicSessionShare', 'account'].includes(String(property)))
                || delegate === null || typeof delegate !== 'object') return delegate;
            return new Proxy(delegate, { get(owner, operation, delegateReceiver) {
                const method: unknown = Reflect.get(owner, operation, delegateReceiver);
                if (typeof method !== 'function' || !String(operation).startsWith('find')) return method;
                if (property === 'account' && operation !== 'findMany') return method.bind(owner);
                return (...args: unknown[]) => observeQuery(Reflect.apply(method, owner, args), result => {
                    const select: unknown = args[0] && typeof args[0] === 'object' ? Reflect.get(args[0], 'select') : null;
                    const ancestry = property === 'discussionMessage' && select && typeof select === 'object'
                        && Object.keys(select).length === 2 && Reflect.get(select, 'replyTargetV1') === true;
                    reads.push({ model: ancestry ? 'ancestors' : String(property), rows: Array.isArray(result) ? result.length : result ? 1 : 0 });
                });
            } });
        },
    });
    const original = db.$transaction;
    const sqliteRead = storage.withSqliteReadSnapshot;
    const sqlite = storage.getDbProviderFromEnv(process.env, 'postgres') === 'sqlite';
    const spy = sqlite ? vi.spyOn(storage, 'withSqliteReadSnapshot').mockImplementation((read, options) => {
        transactions++;
        return sqliteRead(tx => read(observe(tx)), options);
    }) : null;
    if (!sqlite) db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        transactions++;
        const callback = args[0];
        return typeof callback !== 'function' ? Reflect.apply(target, receiver, args)
            : Reflect.apply(target, receiver, [(tx: Tx) => callback(observe(tx)), ...args.slice(1)]);
    } });
    try { return { result: await run(), reads, transactions }; }
    finally { spy?.mockRestore(); if (!sqlite) db.$transaction = original; }
}

async function account() {
    const row = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    fixtureAccountIds.push(row.id);
    return row;
}

async function seedDiscussions(ownerAccountId: string, count: number, extra: Readonly<{ lastMessageAt?: Date }> = {}) {
    const ids = Array.from({ length: count }, () => randomUUID());
    await db.discussion.createMany({ data: ids.map(id => ({ id, ownerAccountId, createdByAccountId: ownerAccountId,
        encryptionMode: 'plain', dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        creationLocalId: id, creationEqualityEvidenceV1: evidence,
        titleContent: { t: 'plain', v: { v: 1, title: 'Costs' } }, messageSeq: 1,
        lastMessageAt: extra.lastMessageAt ?? new Date(1_000),
    })) });
    return ids;
}

/** Same deciding owner contracts run against disposable PostgreSQL and SQLite. */
export function discussionReadCostContracts() {
    afterEach(async () => {
        const ids = fixtureAccountIds.splice(0);
        await db.artifact.deleteMany({ where: { accountId: { in: ids } } });
        await db.sessionMessage.deleteMany({ where: { session: { accountId: { in: ids } } } });
        await db.session.deleteMany({ where: { accountId: { in: ids } } });
        await db.account.deleteMany({ where: { id: { in: ids } } });
    });
    it('rechecks mixed source quotes in batches without multiplying reads by source or message count', async () => {
        const owner = await account();
        const sources: DiscussionQuoteSource[] = [];
        for (let index = 0; index < DISCUSSION_DEFAULT_PAGE_SIZE_V1; index++) {
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            const message = await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, content: { t: 'plain', v: { text: 'Session quote' } } } });
            sources.push({ kind: 'session', sessionId: session.id, messageId: message.id });
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Doc' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Doc quote' })), dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            sources.push({ kind: 'doc', doc: { ref: { kind: 'doc', serverId: 'home', artifactId: artifact.artifact.id },
                revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } } });
        }
        const read = (selected: readonly DiscussionQuoteSource[]) => inReadSnapshot(async tx => {
            const observed = observePrismaReads(tx, ['session', 'sessionMessage', 'artifact']);
            const admissions = new Map<string, DiscussionResult<void>>();
            await admitDiscussionQuoteSourcesInTx(observed.tx, { actorAccountId: owner.id, authentication, sources: selected, admissions });
            return { admissions, reads: observed.reads };
        });
        const one = await read(sources.slice(0, 2));
        const page = await read(sources);
        const repeated = await read([...sources, ...sources, ...sources]);
        expect(page.reads).toEqual(one.reads);
        expect(repeated.reads).toEqual(one.reads);
        expect([...page.admissions.values()].every(admission => admission.ok)).toBe(true);
        const revoked = sources.find((source): source is Extract<DiscussionQuoteSource, { kind: 'session' }> => source.kind === 'session')!;
        await db.sessionMessage.delete({ where: { id: revoked.messageId } });
        const changed = await read(sources);
        expect(changed.admissions.get(discussionQuoteSourceKey(revoked))).toEqual({ ok: false, error: 'discussion_content_unavailable' });
        expect([...changed.admissions.values()].filter(admission => !admission.ok)).toHaveLength(1);
    });
    it.each(['messages', 'attention'] as const)('admits each stored message field once for a %s page response, retaining malformed-storage rejection', async readKind => {
        const owner = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const ids = Array.from({ length: 20 }, () => randomUUID());
        await db.discussionMessage.createMany({ data: ids.map((id, index) => ({ id, discussionId,
            seq: index + 1, localId: id, authorAccountId: owner.id, requestEqualityEvidenceV1: evidence,
            producerV1: { v: 1, kind: 'agent', sessionId: 'agent-a' },
            ...(index ? { replyTargetV1: { kind: 'message', messageId: ids[index - 1] } } : {}),
            addressingV1: { throughSeq: index + 1, participantSessionIds: ['agent-a'] },
            docEditProposalDispositionV1: { state: 'open' }, content: body,
        })) });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: ids.length } });
        await db.discussionReadState.create({ data: { discussionId, accountId: owner.id, lastReadSeq: 0 } });
        // Observation only: both entry points still run the real schema parser.
        // Counts bracket the public read, after fixture writes and before response assertions.
        const schemas = { producer: DiscussionProducerV1StoredSchema,
            envelope: createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema),
            reply: DiscussionReplyTargetV1Schema, addressing: DiscussionMessageAddressingV1Schema,
            disposition: DocEditProposalDispositionV1Schema };
        const observations = Object.entries(schemas).map(([field, schema]) => ({ field,
            parse: vi.spyOn(schema, 'parse'), safeParse: vi.spyOn(schema, 'safeParse') }));
        const input = { actorAccountId: owner.id, authentication, discussionId, limit: ids.length };
        try {
            const result = readKind === 'messages' ? await readDiscussionMessages(input) : await readDiscussionAttention(input);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error);
            const messages = 'messages' in result.value ? result.value.messages
                : result.value.discussions.flatMap(entry => entry.occurrences.map(occurrence => occurrence.message));
            expect(messages).toHaveLength(ids.length);
            const counts = Object.fromEntries(observations.map(({ field, parse, safeParse }) =>
                [field, parse.mock.calls.length + safeParse.mock.calls.length]));
            console.info('DISCUSSION_ADMISSION_COST', counts);
            // Attention also admits and projects the one Discussion title envelope.
            expect(counts).toEqual({ producer: 20, envelope: readKind === 'attention' ? 22 : 20, reply: 19, addressing: 20, disposition: 20 });
        } finally { for (const observation of observations) { observation.parse.mockRestore(); observation.safeParse.mockRestore(); } }
        if (readKind === 'attention') return;
        for (const field of ['producerV1', 'replyTargetV1', 'addressingV1', 'docEditProposalDispositionV1', 'content'] as const) {
            const before = await db.discussionMessage.findUniqueOrThrow({ where: { id: ids[0] }, select: {
                producerV1: true, replyTargetV1: true, addressingV1: true, docEditProposalDispositionV1: true, content: true,
            } });
            await db.discussionMessage.update({ where: { id: ids[0] }, data: { [field]: { malformed: true } } });
            expect(await readDiscussionMessages({ ...input, messageId: ids[0] })).toMatchObject({ ok: false, error: 'discussion_invalid_content' });
            await db.discussionMessage.update({ where: { id: ids[0] }, data: { [field]: before[field] ?? storage.prismaRuntime.DbNull } });
        }
    });

    it('selects attention for one changed Discussion before materializing a 300-Discussion inventory', async () => {
        const owner = await account(), author = await account();
        const ids = await seedDiscussions(owner.id, 300);
        await db.discussionMessage.createMany({ data: ids.map(discussionId => ({ discussionId, seq: 1,
            localId: randomUUID(), authorAccountId: author.id, requestEqualityEvidenceV1: evidence,
            content: body, createdAt: new Date(1000) })) });
        await db.discussionReadState.createMany({ data: ids.map(discussionId => ({ discussionId, accountId: owner.id, lastReadSeq: 0 })) });
        const input = { actorAccountId: owner.id, authentication, discussionId: ids[0]!, limit: 100 };
        const measured = await measure(() => readDiscussionAttention(input));
        expect(measured.result).toMatchObject({ ok: true, value: { nextCursor: null,
            discussions: [{ discussion: { id: ids[0] }, occurrences: [{ message: { discussionId: ids[0] } }] }] } });
        if (!measured.result.ok) throw new Error(measured.result.error);
        expect(measured.result.value.discussions).toHaveLength(1);
        const materialized = measured.reads.filter(read => read.model === 'discussionMessage').reduce((total, read) => total + read.rows, 0);
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'N2-PERFLIST', inventory: ids.length, materialized }));
        expect(materialized).toBe(1);
        const frontierInput = { ...input, afterCursor: encodeDiscussionListCursorV1({ v: 1, at: 1001, id: 'frontier' }) };
        expect(await readDiscussionAttention(frontierInput)).toMatchObject({ ok: true, value: { discussions: [], nextCursor: null } });
        const denied = await readDiscussionAttention({ ...input, actorAccountId: author.id });
        expect(denied).toMatchObject({ ok: true, value: { discussions: [], nextCursor: null } });
    });
    it('D1 rejects malformed list and attention cursors before acquiring a database transaction', async () => {
        const reader = { actorAccountId: randomUUID(), authentication, cursor: 'invalid', limit: 1 };
        const attention = await measure(() => readDiscussionAttention(reader));
        const lowerBound = await measure(() => readDiscussionAttention({ actorAccountId: reader.actorAccountId,
            authentication, afterCursor: 'invalid', limit: 1 }));
        const list = await measure(() => listDiscussions(reader));
        expect(attention.result).toEqual({ ok: false, error: 'discussion_invalid_content' });
        expect(lowerBound.result).toEqual(attention.result);
        expect(list.result).toEqual(attention.result);
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'D1', attentionTransactions: attention.transactions,
            listTransactions: list.transactions }));
        expect(attention.transactions).toBe(0);
        expect(lowerBound.transactions).toBe(0);
        expect(list.transactions).toBe(0);
    });
    it('pages exact Discussion attention within the inclusive loaded occurrence frontier', async () => {
        const owner = await account(), author = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const messageIds = ['frontier-a', 'frontier-b', 'frontier-c'].map(suffix => `${randomUUID()}-${suffix}`).sort();
        await db.discussionMessage.createMany({ data: messageIds.map((id, index) => ({ id, discussionId, seq: index + 1,
            localId: id, authorAccountId: author.id, requestEqualityEvidenceV1: evidence, content: body,
            createdAt: new Date(1001) })) });
        await db.discussionMessage.create({ data: { discussionId, seq: 4, localId: randomUUID(), authorAccountId: author.id,
            requestEqualityEvidenceV1: evidence, content: body, createdAt: new Date(1000) } });
        await db.discussionReadState.create({ data: { discussionId, accountId: owner.id, lastReadSeq: 0 } });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: 4 } });
        const input = { actorAccountId: owner.id, authentication, discussionId, limit: 1,
            afterCursor: encodeDiscussionListCursorV1({ v: 1, at: 1001, id: messageIds[1]! }) };
        const first = await readDiscussionAttention(input);
        expect(first).toMatchObject({ ok: true, value: { discussions: [{ occurrences: [{ message: { id: messageIds[2] } }] }] } });
        if (!first.ok || !first.value.nextCursor) throw new Error('Expected exact attention continuation');
        const second = await readDiscussionAttention({ ...input, cursor: first.value.nextCursor });
        expect(second).toMatchObject({ ok: true, value: { nextCursor: null,
            discussions: [{ occurrences: [{ message: { id: messageIds[1] } }] }] } });
        if (!second.ok) throw new Error(second.error);
        expect(second.value.discussions[0]?.occurrences).toHaveLength(1);
    });
    it('selects one exact committed message without acquiring unrelated history and keeps local IDs private', async () => {
        const owner = await account(), another = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const rows = Array.from({ length: 210 }, (_, index) => ({ discussionId, seq: index + 1,
            localId: `private-${index + 1}`, authorAccountId: index === 1 ? another.id : owner.id,
            requestEqualityEvidenceV1: evidence, content: body }));
        await db.discussionMessage.createMany({ data: rows });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: rows.length } });
        const selected = await db.discussionMessage.findFirstOrThrow({ where: { discussionId, seq: 3 } });
        const foreign = await db.discussionMessage.findFirstOrThrow({ where: { discussionId, seq: 2 } });
        const read = { actorAccountId: owner.id, authentication, discussionId };
        const measured = await measure(() => readDiscussionMessages({ ...read, messageId: selected.id, throughSeq: 3 }));
        expect(measured.result).toMatchObject({ ok: true, value: { messages: [{ id: selected.id, seq: 3 }],
            hasMoreOlder: false, messageSeq: 3 } });
        if (!measured.result.ok) throw new Error(measured.result.error);
        expect(measured.result.value.messages).toHaveLength(1);
        expect(measured.reads.filter(read => read.model === 'discussionMessage').reduce((sum, read) => sum + read.rows, 0)).toBe(1);
        expect(await readDiscussionMessages({ ...read, messageId: selected.id, throughSeq: 2 }))
            .toEqual({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 2 } });
        expect(await readDiscussionMessages({ ...read, messageId: foreign.id }))
            .toMatchObject({ ok: true, value: { messages: [{ id: foreign.id, localId: null }] } });
        expect(await readDiscussionMessages({ ...read, localId: foreign.localId! }))
            .toEqual({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 210 } });
        expect(await readDiscussionMessages({ ...read, localId: selected.localId!, throughSeq: 3 }))
            .toMatchObject({ ok: true, value: { messages: [{ id: selected.id, localId: selected.localId }] } });
        expect(await readDiscussionMessages({ ...read, messageId: randomUUID() }))
            .toEqual({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 210 } });
        const [otherDiscussionId] = await seedDiscussions(owner.id, 1);
        expect(await readDiscussionMessages({ ...read, discussionId: otherDiscussionId, messageId: selected.id }))
            .toEqual({ ok: true, value: { messages: [], hasMoreOlder: false, messageSeq: 1 } });
        expect(await readDiscussionMessages({ ...read, actorAccountId: another.id, messageId: selected.id }))
            .toEqual({ ok: false, error: 'discussion_not_found' });
    });
    it.each([1, 1_000, 20_000])('B-S1 reads no inventory rows for empty limit:1 attention with N=%i', async count => {
        const owner = await account();
        const ids = await seedDiscussions(owner.id, count);
        await db.discussionMessage.createMany({ data: ids.map(discussionId => ({ discussionId, localId: randomUUID(), seq: 1,
            authorAccountId: owner.id, requestEqualityEvidenceV1: evidence, content: body })) });
        await db.discussionReadState.createMany({ data: ids.map(discussionId => ({ discussionId, accountId: owner.id, lastReadSeq: 1 })) });
        const measured = await measure(() => readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }));
        expect(measured.result).toEqual({ ok: true, value: { discussions: [], nextCursor: null, incomplete: false } });
        const materialized = measured.reads.filter(read => read.model === 'discussion' || read.model === 'discussionReadState')
            .reduce((sum, read) => sum + read.rows, 0);
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'B-S1', count, materialized, reads: measured.reads.length }));
        expect(materialized).toBe(0);
        // The empty page and Account-wide key-unavailability fact are the only
        // two Discussion resource questions; inventory size adds no reads.
        expect(measured.reads.length).toBeLessThanOrEqual(2);
        const keys = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
        await db.discussion.updateMany({ where: { ownerAccountId: owner.id }, data: { encryptionMode: 'e2ee', dataEncryptionKey: envelope,
            titleContent: { t: 'encrypted', c: 'AA==' } } });
        await db.discussionMessage.updateMany({ where: { discussion: { ownerAccountId: owner.id } }, data: { content: { t: 'encrypted', c: 'AA==' } } });
        const encrypted = await measure(() => readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }));
        expect(encrypted.result).toEqual(measured.result);
        const encryptedRows = encrypted.reads.filter(read => read.model === 'discussion' || read.model === 'discussionReadState')
            .reduce((sum, read) => sum + read.rows, 0);
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'B-S1-e2ee', count, materialized: encryptedRows, reads: encrypted.reads.length }));
        expect(encryptedRows).toBe(0);
        expect(encrypted.reads.length).toBeLessThanOrEqual(2);
    });

    it('B-S1 preserves global incomplete across the page cursor and rechecks repaired encrypted keys', async () => {
        const owner = await account();
        const keys = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const [discussionId, readyId] = await seedDiscussions(owner.id, 2);
        await db.discussion.update({ where: { id: discussionId }, data: { encryptionMode: 'e2ee', dataEncryptionKey: new Uint8Array([1]) } });
        expect(await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }))
            .toEqual({ ok: true, value: { incomplete: true, discussions: [], nextCursor: null } });
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
        await db.discussion.update({ where: { id: readyId }, data: { encryptionMode: 'e2ee', dataEncryptionKey: envelope } });
        expect(await readDiscussionAttention({ actorAccountId: owner.id, authentication, discussionId: readyId, limit: 1 }))
            .toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
        expect(await readDiscussionAttention({ actorAccountId: owner.id, authentication, discussionId, limit: 1 }))
            .toEqual({ ok: true, value: { incomplete: true, discussions: [], nextCursor: null } });
        await db.discussion.update({ where: { id: discussionId }, data: { dataEncryptionKey: envelope } });
        expect(await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }))
            .toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
    });

    it('B-S1 keeps erased/Agent/JSON-null authors unread, excludes own humans, and pages exact current cursors', async () => {
        const owner = await account(), author = await account();
        const [discussionId, untracked] = await seedDiscussions(owner.id, 2);
        const ids = Array.from({ length: 6 }, () => randomUUID());
        await db.discussionMessage.createMany({ data: ids.map((id, index) => ({ id, discussionId, localId: id, seq: index + 1,
            authorAccountId: index === 1 ? author.id : index === 2 ? null : owner.id,
            requestEqualityEvidenceV1: evidence, content: body, createdAt: new Date(Date.UTC(2026, 9, 23, 11) + Math.floor(index / 2)),
            ...(index === 3 ? { producerV1: { v: 1, kind: 'agent', sessionId: randomUUID() } }
                : index === 4 ? { producerV1: storage.prismaRuntime.JsonNull } : {}),
        })) });
        await db.discussionMessageMention.create({ data: { messageId: ids[1], accountId: owner.id } });
        await db.discussionMessage.create({ data: { discussionId: untracked, localId: randomUUID(), seq: 1,
            authorAccountId: author.id, requestEqualityEvidenceV1: evidence, content: body, createdAt: new Date(2_000) } });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: 6 } });
        await db.discussionReadState.create({ data: { discussionId, accountId: owner.id, lastReadSeq: 0 } });
        const occurrences: Array<{ id: string; type: string }> = [];
        const expected = [1, 2, 3, 4].sort((a, b) => Math.floor(b / 2) - Math.floor(a / 2) || ids[b].localeCompare(ids[a]));
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
            const result = await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1, ...(cursor ? { cursor } : {}) });
            if (!result.ok) throw new Error(result.error);
            const page = result.value.discussions.flatMap(entry => entry.occurrences.map(occurrence => ({ id: occurrence.message.id, type: occurrence.type })));
            expect(page.map(row => row.id)).toEqual([ids[expected[occurrences.length]]]);
            occurrences.push(...page);
            cursor = result.value.nextCursor ?? undefined;
            if (cursor) {
                expect(seenCursors.has(cursor)).toBe(false);
                seenCursors.add(cursor);
            }
        } while (cursor);
        expect(occurrences).toEqual(expected.map(index => ({ id: ids[index], type: index === 1 ? 'mention' : 'update' })));
        expect(new Set(occurrences.map(row => row.id)).size).toBe(expected.length);
        const measuredWhole = await measure(() => readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 100 }));
        const whole = measuredWhole.result;
        expect(whole).toMatchObject({ ok: true, value: { nextCursor: null } });
        if (!whole.ok) throw new Error(whole.error);
        expect(whole.value.discussions.flatMap(entry => entry.occurrences.map(row => row.message.id))).toEqual(expected.map(index => ids[index]));
        const cursorReads = measuredWhole.reads.filter(read => read.model === 'discussionReadState').length;
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'D2', cursorReads }));
        expect(cursorReads).toBe(1);
        await db.discussionReadState.update({ where: { discussionId_accountId: { discussionId, accountId: owner.id } }, data: { lastReadSeq: 4 } });
        const after = await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 });
        expect(after).toMatchObject({ ok: true, value: { nextCursor: null, discussions: [{ occurrences: [{ message: { id: ids[4] } }] }] } });
    });

    it('B-S1 rechecks a shared encrypted recipient binding, repaired envelope and revoked grant', async () => {
        const owner = await account(), viewer = await account();
        const ownerKeys = tweetnacl.box.keyPair(), viewerKeys = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        await db.account.update({ where: { id: viewer.id }, data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(viewerKeys.publicKey) } });
        const seal = (publicKey: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes });
        const [discussionId] = await seedDiscussions(owner.id, 1);
        await db.discussion.update({ where: { id: discussionId }, data: { encryptionMode: 'e2ee', dataEncryptionKey: seal(ownerKeys.publicKey) } });
        await db.discussionAccountGrant.create({ data: { discussionId, accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.discussionKeyEnvelope.create({ data: { discussionId, recipientAccountId: viewer.id,
            encryptedDataKey: seal(viewerKeys.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(viewerKeys.publicKey) } });
        const read = () => readDiscussionAttention({ actorAccountId: viewer.id, authentication, limit: 1 });
        expect(await read()).toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
        const rotated = tweetnacl.box.keyPair();
        await db.account.update({ where: { id: viewer.id }, data: createSignedAccountContentBinding(rotated.publicKey) });
        expect(await read()).toEqual({ ok: true, value: { incomplete: true, discussions: [], nextCursor: null } });
        await db.discussionKeyEnvelope.update({ where: { discussionId_recipientAccountId: { discussionId, recipientAccountId: viewer.id } }, data: {
            encryptedDataKey: seal(rotated.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(rotated.publicKey) } });
        expect(await read()).toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
        await db.discussionAccountGrant.delete({ where: { discussionId_accountId: { discussionId, accountId: viewer.id } } });
        await db.account.update({ where: { id: viewer.id }, data: createSignedAccountContentBinding(viewerKeys.publicKey) });
        expect(await read()).toEqual({ ok: true, value: { incomplete: false, discussions: [], nextCursor: null } });
    });

    it.each([1, 1_000])('D5 projects content-disclosed Account actors with one set read at N=%i messages', async count => {
        const owner = await account(), author = await account(), requester = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const serverId = await getOrCreateServerIdentityId();
        const producer = { v: 1 as const, kind: 'agent' as const, sessionId: 'agent-session',
            actionRequestAttributionV1: { requestRef: 'request', requester: { serverId, accountId: requester.id },
                persona: { serverId, sessionId: 'agent-session' }, origin: null } };
        await db.discussionMessage.createMany({ data: Array.from({ length: count }, (_, index) => ({
            discussionId, seq: index + 1, localId: randomUUID(), authorAccountId: author.id,
            requestEqualityEvidenceV1: evidence, content: body,
            ...(index === 0 ? { producerV1: producer } : {}),
        })) });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: count } });
        const storedProducer = (await db.discussionMessage.findFirstOrThrow({ where: { discussionId, seq: 1 },
            select: { producerV1: true } })).producerV1;
        expect(storedProducer).toEqual(producer);
        expect(DiscussionProducerV1StoredSchema.safeParse(storedProducer).success).toBe(true);
        const known = await inReadSnapshot(tx => loadDiscussionKnownAccountActorFactsInTx(tx, [discussionId]));
        expect(known.subjectsByDiscussion.get(discussionId)).toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: requester.id, serverId }),
        ]));
        const measured = await measure(() => listDiscussionParticipants({
            actorAccountId: owner.id, authentication, discussionId,
        }));
        expect(measured.result).toMatchObject({ ok: true, value: { accountActors: expect.arrayContaining([
            expect.objectContaining({ accountId: author.id, accessibility: 'former' }),
            expect.objectContaining({ accountId: requester.id, accessibility: 'former' }),
        ]) } });
        const actorSourceReads = measured.reads.filter(read => read.model === 'discussionMessage');
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'D5', count, actorSourceReads }));
        // One finite request admits once and projects all disclosed actors in one set read.
        expect(actorSourceReads).toEqual([{ model: 'discussionMessage', rows: 1 }]);
    });

    it.each([1, 1_000, 20_000])('B-S2 selects one real Doc thread before N=%i unrelated rows leave storage', async count => {
        const owner = await account();
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Source', kind: 'markdown' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Text' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const doc = { ref: { kind: 'doc' as const, serverId: 'test-home', artifactId: artifact.artifact.id },
            revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } };
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: randomUUID(), anchor: { kind: 'doc', doc },
            titleContent: { t: 'plain', v: { v: 1, title: 'Scoped' } },
            firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { kind: 'doc_passage_comment',
                passage: { ...doc, range: { start: 0, end: 4 }, quote: 'Text' }, content: body.v } },
                replyTarget: { kind: 'doc_passage', doc }, mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const actor = { authentication, actorAccountId: owner.id, discussionId: created.value.discussion.id };
        const rootRequest = { localId: randomUUID(), content: { t: 'plain' as const, v: { kind: 'doc_passage_comment',
            passage: { ...doc, range: { start: 0, end: 4 }, quote: 'Text' }, content: body.v } },
            replyTarget: { kind: 'doc_passage' as const, doc }, mentionedAccountIds: [] };
        expect((await postDiscussionMessage({ ...actor, request: rootRequest })).ok).toBe(true);
        expect((await postDiscussionMessage({ ...actor, request: rootRequest })).ok).toBe(true);
        expect((await postDiscussionMessage({ ...actor, request: { ...rootRequest, localId: randomUUID() } })).ok).toBe(true);
        expect((await postDiscussionMessage({ ...actor, request: { localId: randomUUID(), content: body,
            replyTarget: { kind: 'message', messageId: created.value.firstMessage.id }, mentionedAccountIds: [] } })).ok).toBe(true);
        await seedDiscussions(owner.id, count, { lastMessageAt: new Date(Date.now() + 1_000) });
        const measured = await measure(() => listDiscussions({ authentication, actorAccountId: owner.id,
            anchorDocArtifactId: doc.ref.artifactId, limit: 1 }));
        expect(measured.result).toMatchObject({ ok: true, value: { discussions: [{ id: created.value.discussion.id,
            openCommentCount: 3 }], nextCursor: null } });
        const materialized = measured.reads.filter(read => read.model === 'discussion').reduce((sum, read) => sum + read.rows, 0);
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'B-S2', count, materialized, reads: measured.reads.length }));
        expect(materialized).toBe(2);
        expect(await archiveDiscussion(actor)).toMatchObject({ ok: true, value: { discussion: { openCommentCount: 0 } } });
        expect(await restoreDiscussion(actor)).toMatchObject({ ok: true, value: { discussion: { openCommentCount: 3 } } });
    });

    it('B-S2a keeps page-2 candidates reachable while a thousand foreign rows lie between reachable items', async () => {
        const owner = await account();
        const stranger = await account();
        const create = async (at: number) => {
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Reachable' } },
                firstMessage: { localId: randomUUID(), content: body, mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            await db.discussion.update({ where: { id: created.value.discussion.id }, data: { lastMessageAt: new Date(at) } });
            return created.value.discussion.id;
        };
        const first = await create(4_000);
        await seedDiscussions(stranger.id, 1_000, { lastMessageAt: new Date(3_000) });
        const second = await create(2_000);
        const third = await create(1_000);
        const page1 = await listDiscussions({ actorAccountId: owner.id, authentication, limit: 1 });
        if (!page1.ok || !page1.value.nextCursor) throw new Error('Missing first page');
        expect(page1.value.discussions.map(row => row.id)).toEqual([first]);
        const measured = await measure(() => listDiscussions({ actorAccountId: owner.id, authentication, limit: 1, cursor: page1.value.nextCursor! }));
        expect(measured.result).toMatchObject({ ok: true, value: { discussions: [{ id: second }], nextCursor: expect.any(String) } });
        const materialized = measured.reads.filter(read => read.model === 'discussion').reduce((sum, read) => sum + read.rows, 0);
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'B-S2a', count: 1_000, materialized, reads: measured.reads.length }));
        expect(materialized).toBe(4);
        if (!measured.result.ok || !measured.result.value.nextCursor) throw new Error('Missing second page');
        expect(await listDiscussions({ actorAccountId: owner.id, authentication, limit: 1, cursor: measured.result.value.nextCursor }))
            .toMatchObject({ ok: true, value: { discussions: [{ id: third }], nextCursor: null } });
    });

    it.each([[1, 1], [8, 1], [8, 2]])('D3/D4 admit %i roots across %i Docs once per source and project actors per page', async (count, sourceCount) => {
        const owner = await account(), author = await account();
        const docs: DiscussionDocSource[] = [];
        for (let index = 0; index < sourceCount; index++) {
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Source', kind: 'markdown' })),
                body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Text' })),
                dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            docs.push({ ref: { kind: 'doc' as const, serverId: 'test-home', artifactId: artifact.artifact.id },
                revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } });
        }
        const roots: Array<{ discussionId: string; sourceId: string; messageId: string }> = [];
        for (let index = 0; index < count; index++) {
            const doc = docs[index % sourceCount]!;
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: randomUUID(), anchor: { kind: 'doc', doc },
                titleContent: { t: 'plain', v: { v: 1, title: 'Scoped' } },
                firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { kind: 'doc_passage_comment',
                    passage: { ...doc, range: { start: 0, end: 4 }, quote: 'Text' }, content: body.v } },
                    replyTarget: { kind: 'doc_passage', doc }, mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            const discussionId = created.value.discussion.id;
            const message = await db.discussionMessage.findFirstOrThrow({ where: { discussionId, seq: 1 } });
            await db.discussionMessage.update({ where: { id: message.id }, data: { authorAccountId: author.id } });
            roots.push({ discussionId, sourceId: doc.ref.artifactId, messageId: message.id });
        }
        const counts = (reads: Array<{ model: string }>) => ({
            artifacts: reads.filter(read => read.model === 'artifact').length,
            publications: reads.filter(read => read.model === 'publicSessionShare').length,
            actors: reads.filter(read => read.model === 'account').length,
        });
        const reader = { authentication, actorAccountId: owner.id, limit: 100 };
        const list = await measure(() => listDiscussions({ ...reader,
            ...(sourceCount === 1 ? { anchorDocArtifactId: docs[0]!.ref.artifactId } : {}) }));
        if (!list.result.ok) throw new Error(list.result.error);
        expect(list.result.value.discussions).toHaveLength(count);
        if (sourceCount === 1) {
            expect(list.result.value.discussions.every(row => row.firstMessage?.accountActor?.accountId === author.id
                && row.firstMessage.localId === null)).toBe(true);
        }
        const attention = await measure(() => readDiscussionAttention(reader));
        if (!attention.result.ok) throw new Error(attention.result.error);
        expect(attention.result.value.discussions.flatMap(row => row.occurrences.map(item => item.message.id)).sort())
            .toEqual(roots.map(row => row.messageId).sort());
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'D3/D4', count, sourceCount,
            list: counts(list.reads), attention: counts(attention.reads) }));
        // Content admission batches every exact source; public-link state does
        // not decide whether an authenticated reader may open its contents.
        expect.soft(counts(list.reads)).toEqual({ artifacts: 1, publications: 0, actors: sourceCount === 1 ? 2 : 1 });
        expect.soft(counts(attention.reads)).toEqual({ artifacts: 1, publications: 0, actors: 2 });

        // A later request must re-admit the source, including full mode/key validation.
        const deniedId = docs[0]!.ref.artifactId;
        await db.artifact.update({ where: { id: deniedId }, data: { dataEncryptionKey: new Uint8Array([1]) } });
        const denied = await readDiscussionAttention(reader);
        if (!denied.ok) throw new Error(denied.error);
        expect(denied.value.incomplete).toBe(true);
        expect(denied.value.discussions.flatMap(row => row.occurrences.map(item => item.message.id)).sort())
            .toEqual(roots.filter(row => row.sourceId !== deniedId).map(row => row.messageId).sort());
        const deniedRoots = await listDiscussions({ ...reader, anchorDocArtifactId: deniedId });
        if (!deniedRoots.ok) throw new Error(deniedRoots.error);
        expect(deniedRoots.value.discussions).toHaveLength(roots.filter(row => row.sourceId === deniedId).length);
        expect(deniedRoots.value.discussions.every(row => row.firstMessage === null)).toBe(true);
    });

    it('pages every reachable Doc root and agrees with doc.read across timestamp ties', async () => {
        const owner = await account();
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Source', kind: 'markdown' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Text' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const serverId = await getOrCreateServerIdentityId();
        const doc = { ref: { kind: 'doc' as const, serverId, artifactId: artifact.artifact.id },
            revision: { headerVersion: artifact.artifact.headerVersion, bodyVersion: artifact.artifact.bodyVersion } };
        const roots: Array<{ id: string; at: number }> = [];
        for (let index = 0; index < 8; index++) {
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: randomUUID(), anchor: { kind: 'doc', doc },
                titleContent: { t: 'plain', v: { v: 1, title: 'Scoped' } },
                firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { kind: 'doc_passage_comment',
                    passage: { ...doc, range: { start: 0, end: 4 }, quote: 'Text' }, content: body.v } },
                    replyTarget: { kind: 'doc_passage', doc }, mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            const at = Date.UTC(2026, 9, 23, 11) + Math.floor(index / 2);
            await db.discussion.update({ where: { id: created.value.discussion.id }, data: { lastMessageAt: new Date(at) } });
            roots.push({ id: created.value.discussion.id, at });
        }
        const expected = roots.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)).map(row => row.id);
        const listed = await measure(() => listDiscussions({ authentication, actorAccountId: owner.id,
            anchorDocArtifactId: doc.ref.artifactId, limit: 100 }));
        if (!listed.result.ok) throw new Error(listed.result.error);
        expect(listed.result.value.discussions.map(row => row.id)).toEqual(expected);
        expect(listed.result.value.discussions.reduce((count, row) => count + (row.firstMessage === null ? 0 : row.openCommentCount ?? 0), 0))
            .toBe(expected.length);
        expect(listed.transactions).toBe(1);
        console.info('DOC_COMMENT_LIST_COST', JSON.stringify({ queries: listed.reads.length, reads: listed.reads }));
        expect(listed.reads.filter(read => read.model === 'artifact' || read.model === 'publicSessionShare'))
            .toEqual([{ model: 'artifact', rows: 1 }]);
        const walk: string[] = [], seenCursors = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = await listDiscussions({ authentication, actorAccountId: owner.id, anchorDocArtifactId: doc.ref.artifactId,
                limit: 1, ...(cursor ? { cursor } : {}) });
            if (!page.ok) throw new Error(page.error);
            expect(page.value.discussions.map(row => row.id)).toEqual([expected[walk.length]]);
            walk.push(...page.value.discussions.map(row => row.id));
            cursor = page.value.nextCursor ?? undefined;
            if (cursor) { expect(seenCursors.has(cursor)).toBe(false); seenCursors.add(cursor); }
        } while (cursor);
        expect(walk).toEqual(expected);
        // Opened transport boundaries only; the real doc.read count owner calls
        // the real SQL/admission/projection path on every one-item page.
        const read = await executeDocReadV1({ ref: doc.ref },
            { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: owner.id }, {
                artifactAction: async () => ({ artifact: { artifactId: doc.ref.artifactId, ownerAccountId: owner.id,
                    access: 'admin', header: { title: 'Source', kind: 'markdown' }, body: 'Text', revision: doc.revision,
                    publicAudience: 'none', seq: 1, createdAt: 1, updatedAt: 1 } }),
                discussionAction: async ({ actionId, input }) => {
                    expect(actionId).toBe('discussion.list');
                    const query = DiscussionListInputV1Schema.parse(input);
                    const page = await listDiscussions({ authentication, actorAccountId: owner.id, ...query, limit: 1 });
                    if (!page.ok) throw new Error(page.error);
                    return { v: 1, serverId, ...page.value, incomplete: false,
                        discussions: page.value.discussions.map(({ titleContent, firstMessage, ...row }) => ({ ...row,
                            title: titleContent.t === 'plain' ? DiscussionTitleV1Schema.parse(titleContent.v).title : null,
                            firstMessage: firstMessage ? { ...firstMessage,
                                messageRef: createDiscussionMessageRefV1({ serverId, discussionId: row.id }, firstMessage),
                                content: firstMessage.content.t === 'plain' ? firstMessage.content.v : null } : null,
                        })) };
                },
            });
        expect(read).toMatchObject({ ok: true, result: { openCommentCount: expected.length } });
        expect(walk).toHaveLength(new Set(walk).size);
    });

    it.each([1, 100, 1_000])('B-S3 resolves depth=%i in one set read without fetching unrelated history', async depth => {
        const owner = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const ids = Array.from({ length: depth + 1 }, () => randomUUID());
        await db.discussionMessage.createMany({ data: ids.map((id, index) => ({ id, discussionId, localId: id, seq: index + 1,
            requestEqualityEvidenceV1: evidence, content: body,
            ...(index ? { replyTargetV1: { kind: 'message', messageId: ids[index - 1] } } : {}),
        })) });
        await db.discussionMessage.createMany({ data: Array.from({ length: 1_000 }, (_, index) => ({ discussionId,
            localId: randomUUID(), seq: depth + index + 2, requestEqualityEvidenceV1: evidence, content: body })) });
        const measured = await measure(() => inReadSnapshot(tx => resolveDiscussionDocSourcesInTx(tx, { discussionId,
            messages: [{ id: ids[depth], replyTargetV1: { kind: 'message', messageId: ids[depth - 1] } }] })));
        expect(measured.result).toEqual({ ok: true, value: new Map([[ids[depth], null]]) });
        const reads = measured.reads.filter(read => read.model === 'ancestors');
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'B-S3', depth, reads: reads.length, rows: reads.reduce((sum, read) => sum + read.rows, 0) }));
        expect(reads).toHaveLength(1);
        expect(reads[0].rows).toBe(depth);
    });

    it('B-S3 rejects cycles, missing ancestors and ancestors from another Discussion', async () => {
        const owner = await account();
        const [discussionId, otherId] = await seedDiscussions(owner.id, 2);
        const root = randomUUID(), leaf = randomUUID();
        await db.discussionMessage.createMany({ data: [
            { id: root, discussionId, localId: root, seq: 1, requestEqualityEvidenceV1: evidence, content: body,
                replyTargetV1: { kind: 'message', messageId: leaf } },
            { id: leaf, discussionId, localId: leaf, seq: 2, requestEqualityEvidenceV1: evidence, content: body,
                replyTargetV1: { kind: 'message', messageId: root } },
        ] });
        const read = () => inReadSnapshot(tx => resolveDiscussionDocSourcesInTx(tx, { discussionId,
            messages: [{ id: leaf, replyTargetV1: { kind: 'message', messageId: root } }] }));
        expect(await read()).toEqual({ ok: false, error: 'discussion_invalid_reply_target' });
        await db.discussionMessage.update({ where: { id: root }, data: { discussionId: otherId } });
        expect(await read()).toEqual({ ok: false, error: 'discussion_invalid_reply_target' });
        await db.discussionMessage.delete({ where: { id: root } });
        expect(await read()).toEqual({ ok: false, error: 'discussion_invalid_reply_target' });
    });

    it('B-S1 preserves unread/self-send/cursor semantics and B-S3 attention consumes its admitted source map', async () => {
        const owner = await account();
        const [discussionId] = await seedDiscussions(owner.id, 1);
        const ids = Array.from({ length: 101 }, () => randomUUID());
        await db.discussionMessage.createMany({ data: ids.map((id, index) => ({ id, discussionId, localId: id, seq: index + 1,
            authorAccountId: index === 100 ? null : owner.id, createdAt: new Date(1_000 + index),
            requestEqualityEvidenceV1: evidence, content: body,
            ...(index ? { replyTargetV1: { kind: 'message', messageId: ids[index - 1] } } : {}),
        })) });
        await db.discussion.update({ where: { id: discussionId }, data: { messageSeq: 101, lastMessageAt: new Date(1_100) } });
        await db.discussionReadState.create({ data: { discussionId, accountId: owner.id, lastReadSeq: 0 } });
        const measured = await measure(() => readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }));
        expect(measured.result).toMatchObject({ ok: true, value: { incomplete: false, nextCursor: null,
            discussions: [{ discussion: { id: discussionId }, occurrences: [{ message: { id: ids[100] }, type: 'update' }] }] } });
        // The summary's latest row and the selected occurrence each resolve once;
        // attention must reuse the occurrence projection's source map for decisions.
        const ancestors = measured.reads.filter(read => read.model === 'ancestors');
        console.info('DISCUSSION_READ_COST', JSON.stringify({ finding: 'B-S3-attention', depth: 100, ancestorReads: ancestors.length }));
        expect(ancestors).toHaveLength(2);
        await db.discussionReadState.delete({ where: { discussionId_accountId: { discussionId, accountId: owner.id } } });
        expect(await readDiscussionAttention({ actorAccountId: owner.id, authentication, limit: 1 }))
            .toEqual({ ok: true, value: { incomplete: false, nextCursor: null, discussions: [] } });
    });
}
