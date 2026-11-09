import { type SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessageActionReferenceV1 } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";

import { runSessionMessagesPagePipeline, type SessionMessagesEncryption } from './sessionMessagesPagePipeline';
import { handleMessageUpdatedSocketUpdate, handleNewMessageSocketUpdate } from './sessionSocketUpdate';

// Match the production encryption owner's stable cipher identity until replacement.
function sessionEncryptionGetter(encryption: SessionMessagesEncryption) {
    return () => encryption;
}

function buildEncryptedApiMessage(params: {
    id: string;
    seq: number;
    updatedAt?: number;
    sidechainId?: string | null;
    sourceCreatedAt?: number;
    sourceUpdatedAt?: number;
    transcriptObservationProvenance?: {
        kind: 'non_dependent';
        source: 'background' | 'external' | 'sidechain' | 'history';
    };
    messageActionReference?: MessageActionReferenceV1;
}): SessionMessageV1 {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: params.sidechainId ?? null,
        content: {
            t: 'encrypted',
            c: `cipher-${params.id}`,
        },
        createdAt: 1_000 + params.seq,
        updatedAt: params.updatedAt ?? 2_000 + params.seq,
        ...(params.sourceCreatedAt !== undefined ? { sourceCreatedAt: params.sourceCreatedAt } : {}),
        ...(params.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: params.sourceUpdatedAt } : {}),
        ...(params.transcriptObservationProvenance !== undefined
            ? { transcriptObservationProvenance: params.transcriptObservationProvenance }
            : {}),
        ...(params.messageActionReference !== undefined
            ? { messageActionReference: params.messageActionReference }
            : {}),
    } as SessionMessageV1;
}

function buildTextContent(message: SessionMessageV1, text = `hello-${message.id}`) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'user',
            content: { type: 'text', text },
        },
    };
}

function buildLifecycleContent(message: SessionMessageV1) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        content: {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'kimi',
                data: { type: 'turn_aborted', id: `task-${message.seq}` },
            },
        },
    };
}

describe('runSessionMessagesPagePipeline', () => {
    it.each(['scope', 'session', 'cipher', 'superseded'] as const)('stops decrypt batches when %s retires during a yield', async (retirement) => {
        let current = true;
        let known = true;
        let continuePaging = true;
        const decryptedIds: string[] = [];
        const encryption: SessionMessagesEncryption = { decryptMessages: async rows => {
            decryptedIds.push(...rows.map(row => row.id));
            return rows.map(row => buildTextContent(row));
        } };
        let reader = encryption;
        const received = new Map<string, Map<string, number>>();
        const applied: NormalizedMessage[] = [];
        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1', purpose: 'newer', lifecyclePolicy: 'suppress',
            page: { direction: 'newer', requestPath: '/messages', scope: 'main' },
            getSessionEncryption: () => reader, isCurrent: () => current,
            isSessionKnown: () => known, shouldContinue: () => continuePaging,
            messageDecryptBatchSize: 1,
            yieldToMessageDecryptBatch: async () => {
                if (retirement === 'scope') current = false;
                if (retirement === 'session') known = false;
                if (retirement === 'cipher') reader = { decryptMessages: encryption.decryptMessages };
                if (retirement === 'superseded') continuePaging = false;
            },
            request: async () => Response.json({ messages: [1, 2, 3].map(seq => buildEncryptedApiMessage({ id: `m${seq}`, seq })), nextAfterSeq: null }),
            sessionReceivedMessages: received, applyMessages: (_id, rows) => { applied.push(...rows); },
            log: { log: () => {} },
        });
        expect(decryptedIds).toEqual(['m1']);
        expect(applied).toEqual([]);
        expect(received.size).toBe(0);
        expect(result.applied).toBe(0);
    });
    it.each(['new-message', 'message-updated'] as const)(
        'does not disclose or consume a plain row delivered to an E2EE Session by %s',
        async (updateType) => {
            const { Encryption } = await import('@/sync/encryption/encryption');
            const encryption = await Encryption.create(new Uint8Array(32).fill(7));
            const sessionId = 'socket-mode-mismatch';
            await encryption.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(8)]]));
            storage.getState().applySessions([createSessionFixture({
                id: sessionId, seq: 1, encryptionMode: 'e2ee', encryptedContentAvailability: 'ready',
            })]);
            const message = {
                ...buildEncryptedApiMessage({ id: 'disallowed-plain-row', seq: 2 }),
                content: {
                    t: 'plain' as const,
                    v: { role: 'user', content: { type: 'text', text: 'Must not disclose' } },
                },
            };
            const sessionReceivedMessages = new Map<string, Map<string, number>>();
            let materializedSeq = 1;
            const handleUpdate = updateType === 'new-message'
                ? handleNewMessageSocketUpdate
                : handleMessageUpdatedSocketUpdate;

            await handleUpdate({
                updateData: { id: 'mismatch-update', seq: 10, createdAt: 2_000,
                    body: { t: updateType, sid: sessionId, message } },
                getSession: (id) => storage.getState().sessions[id],
                getSessionEncryption: (id) => encryption.getSessionEncryption(id),
                applySessions: (sessions) => storage.getState().applySessions(sessions),
                applyMessages: (id, messages) => storage.getState().applyMessages(id, messages),
                fetchSessions: () => {},
                isMutableToolCall: () => false,
                invalidateScmStatus: () => {},
                isSessionMessagesLoaded: () => true,
                isSessionFullContentConsumerActive: () => true,
                getSessionMaterializedMaxSeq: () => materializedSeq,
                markSessionMaterializedMaxSeq: (_id, seq) => { materializedSeq = seq; },
                onMessageGapDetected: () => {},
                sessionReceivedMessages,
            });

            expect(Object.keys(storage.getState().sessionMessages[sessionId]?.messagesById ?? {})).toEqual([]);
            expect(sessionReceivedMessages.get(sessionId)?.has(message.id) ?? false).toBe(false);
            expect(materializedSeq).toBe(1);
            expect(storage.getState().sessions[sessionId].seq).toBe(1);
        },
    );

    it.each(['rejected', 'unresolved'] as const)('does not certify or consume a %s encrypted page and retries the same rows', async (failure) => {
        const message = buildEncryptedApiMessage({ id: 'm101', seq: 101 });
        const received = new Map<string, Map<string, number>>();
        const applied: NormalizedMessage[] = [];
        let materializedSeq = 100;
        let appliedIdsAtCommit: string[] = [];
        let failDecryption = true;
        const params: Parameters<typeof runSessionMessagesPagePipeline>[0] = {
            sessionId: 's1',
            purpose: 'newer',
            page: { direction: 'newer', requestPath: '/v1/sessions/s1/messages?afterSeq=100', scope: 'main' },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: sessionEncryptionGetter({
                decryptMessages: async (messages) => {
                    if (failDecryption) {
                        if (failure === 'rejected') throw new Error('Decryption unavailable');
                        return messages.map(() => null);
                    }
                    return messages.map((row) => buildTextContent(row));
                },
            }),
            request: async () => new Response(JSON.stringify({ messages: [message], nextAfterSeq: null })),
            sessionReceivedMessages: received,
            applyMessages: (_sessionId, messages) => { applied.push(...messages); },
            onMessagesPage: (page) => {
                appliedIdsAtCommit = applied.map((row) => row.id);
                materializedSeq = page.messages[0].seq;
            },
            log: { log: () => {} },
        };

        await expect(runSessionMessagesPagePipeline(params)).rejects.toThrow();
        expect(materializedSeq).toBe(100);
        expect(received.get('s1')?.has('m101') ?? false).toBe(false);
        expect(applied).toEqual([]);

        failDecryption = false;
        await runSessionMessagesPagePipeline(params);
        expect(materializedSeq).toBe(101);
        expect(appliedIdsAtCommit).toEqual(['m101']);
        expect(received.get('s1')?.get('m101')).toBe(message.updatedAt);
        expect(applied.map((row) => row.id)).toEqual(['m101']);
    });

    it('repairs only selected identities without applying or consuming neighboring page rows', async () => {
        const selected = buildEncryptedApiMessage({ id: 'selected', seq: 15 });
        const neighbor = buildEncryptedApiMessage({ id: 'neighbor', seq: 9000 });
        const received = new Map<string, Map<string, number>>();
        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: { direction: 'newer', requestPath: '/v1/sessions/s1/messages?afterSeq=14', scope: 'all' },
            lifecyclePolicy: 'suppress',
            messageIds: new Set(['selected']),
            getSessionEncryption: sessionEncryptionGetter({ decryptMessages: async (messages) => messages.map((row) => buildTextContent(row)) }),
            request: async () => new Response(JSON.stringify({ messages: [selected, neighbor], nextAfterSeq: null })),
            sessionReceivedMessages: received,
            applyMessages: () => {},
            log: { log: () => {} },
        });
        expect(result.appliedMessageIds).toEqual(['selected']);
        expect([...received.get('s1')!.keys()]).toEqual(['selected']);
    });

    it('drops a held page after the Session cipher is replaced without applying rows or advancing currentness', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        await encryption.initializeSessions(new Map([['s1', new Uint8Array(32).fill(8)]]));
        const reader = encryption.getSessionEncryption('s1')!;
        const ciphertext = await reader.encryptRaw({ role: 'user', content: { type: 'text', text: 'stale' } });
        const messages = [{ ...buildEncryptedApiMessage({ id: 'stale-cipher', seq: 1 }), content: { t: 'encrypted', c: ciphertext } }];
        storage.getState().applySessions([createSessionFixture({ id: 's1' })]);
        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        let publishedPage = false;
        let failed = false;
        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1', purpose: 'initial',
            page: { direction: 'initial', requestPath: '/messages', scope: 'main' },
            lifecyclePolicy: 'suppress', sessionEncryptionMode: 'e2ee',
            getSessionEncryption: () => encryption.getSessionEncryption('s1'),
            request: async () => {
                await encryption.initializeSessions(new Map([['s1', new Uint8Array(32).fill(9)]]));
                return Response.json({ messages });
            },
            sessionReceivedMessages,
            applyMessages: (id, rows) => storage.getState().applyMessages(id, rows),
            onMessagesPage: () => { publishedPage = true; },
            onContentAuthenticationFailure: () => { failed = true; },
            log: { log: () => {} },
        });
        expect(result.applied).toBe(0);
        expect(publishedPage).toBe(false);
        expect(failed).toBe(false);
        expect(sessionReceivedMessages.size).toBe(0);
        expect(Object.keys(storage.getState().sessionMessages.s1?.messagesById ?? {})).toEqual([]);
    });

    it.each(['authentication_failure', 'unsupported_content', 'authenticated_false', 'authenticated_zero', 'authenticated_empty_string', 'authenticated_null'] as const)(
        'preserves valid rows without certifying cryptographically unreadable pages (%s)',
        async (failure) => {
            const { Encryption } = await import('@/sync/encryption/encryption');
            const encryption = await Encryption.create(new Uint8Array(32).fill(7));
            const wrongWriter = await Encryption.create(new Uint8Array(32).fill(7));
            await encryption.initializeSessions(new Map([['s1', new Uint8Array(32).fill(8)]]));
            await wrongWriter.initializeSessions(new Map([['s1', new Uint8Array(32).fill(9)]]));
            const reader = encryption.getSessionEncryption('s1')!;
            const text = { role: 'user', content: { type: 'text', text: 'kept content' } };
            const goodCiphertext = await reader.encryptRaw(text);
            const otherCiphertext = failure === 'authentication_failure'
                ? await wrongWriter.getSessionEncryption('s1')!.encryptRaw(text)
                : await reader.encryptRaw({
                    unsupported_content: { unsupportedFutureRecord: true },
                    authenticated_false: false,
                    authenticated_zero: 0,
                    authenticated_empty_string: '',
                    authenticated_null: null,
                }[failure]);
            const messages = [goodCiphertext, otherCiphertext].map((ciphertext, index) => ({
                ...buildEncryptedApiMessage({ id: `crypto-row-${index}`, seq: index + 1 }),
                content: { t: 'encrypted' as const, c: ciphertext },
            }));
            const applied: NormalizedMessage[] = [];
            const sessionReceivedMessages = new Map<string, Map<string, number>>();
            let contentFailure = false;
            let pagePublished = false;
            storage.getState().applySessions([createSessionFixture({
                id: 's1', encryptionMode: 'e2ee', encryptedContentAvailability: 'ready',
            })]);

            const load = runSessionMessagesPagePipeline({
                sessionId: 's1', purpose: 'initial',
                page: { direction: 'initial', requestPath: '/messages', scope: 'main' },
                lifecyclePolicy: 'suppress', sessionEncryptionMode: 'e2ee',
                getSessionEncryption: () => reader,
                request: async () => new Response(JSON.stringify({ messages })),
                sessionReceivedMessages,
                applyMessages: (id, rows) => {
                    applied.push(...rows);
                    storage.getState().applyMessages(id, rows);
                },
                onContentAuthenticationFailure: () => { contentFailure = true; },
                onMessagesPage: () => { pagePublished = true; },
                log: { log: () => {} },
            });

            if (failure === 'authentication_failure') {
                await expect(load).rejects.toMatchObject({ name: 'SessionMessagePageDecryptionError' });
            } else {
                expect((await load).appliedMessageIds).toEqual(['crypto-row-0']);
            }
            expect(pagePublished).toBe(failure !== 'authentication_failure');
            expect(applied).toEqual([expect.objectContaining({ id: 'crypto-row-0' })]);
            expect(Object.values(storage.getState().sessionMessages.s1?.messagesById ?? {})).toEqual([
                expect.objectContaining({ realID: 'crypto-row-0', kind: 'user-text', text: 'kept content' }),
            ]);
            expect(contentFailure).toBe(failure === 'authentication_failure');
            expect(sessionReceivedMessages.get('s1')?.has('crypto-row-0')).toBe(true);
            expect(sessionReceivedMessages.get('s1')?.has('crypto-row-1')).not.toBe(true);
        },
    );

    it.each(['home-a', 'home-b', undefined])('qualifies actor metadata from the page request Home outside encrypted content (%s)', async (serverId) => {
        const actor = { v: 1, accountId: 'alice', profile: null };
        const row = { ...buildEncryptedApiMessage({ id: 'actor-row', seq: 1 }), accountActor: actor };
        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1', serverId, purpose: 'initial',
            page: { direction: 'initial', requestPath: '/messages', scope: 'main' },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: sessionEncryptionGetter({ decryptMessages: async (rows) => rows.map((item) => buildTextContent(item)) }),
            request: async () => new Response(JSON.stringify({ messages: [row] })),
            sessionReceivedMessages: new Map(), applyMessages: () => {}, log: { log: () => {} },
        });
        expect(result.normalizedMessages[0]).toMatchObject({ accountActor: serverId ? { ...actor, serverId } : null });
    });

    it('refreshes actor presentation when the durable row timestamp has not changed', async () => {
        const row = buildEncryptedApiMessage({ id: 'actor-refresh', seq: 1 });
        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        const profile = { firstName: 'Alice', lastName: null, username: null, avatarUrl: null };
        const decryptMessages = vi.fn(async (rows: SessionMessageV1[]) => rows.map((item) => buildTextContent(item)));
        let messageActionReference: MessageActionReferenceV1 | undefined = { v: 1, sessionId: 's1', messageId: row.id, observedRevision: 'revision-1' };
        const refresh = (accountActor: { v: 1; accountId: string; profile: typeof profile | null } | null | undefined) =>
            runSessionMessagesPagePipeline({
                sessionId: 's1', serverId: 'home-a', purpose: 'initial',
                page: { direction: 'initial', requestPath: '/messages', scope: 'main' },
                lifecyclePolicy: 'suppress',
                getSessionEncryption: sessionEncryptionGetter({ decryptMessages }),
                request: async () => Response.json({ messages: [{ ...row, accountActor, messageActionReference }] }),
                sessionReceivedMessages,
                applyMessages: (sessionId, messages) => storage.getState().applyMessages(sessionId, messages),
                applyMessageMetadata: (sessionId, metadataUpdates) => storage.getState().applyMessages(sessionId, [], { metadataUpdates }),
                log: { log: () => {} },
            });
        storage.getState().applySessions([createSessionFixture({ id: 's1' })]);
        await refresh({ v: 1, accountId: 'alice', profile });
        const initial = Object.values(storage.getState().sessionMessages.s1?.messagesById ?? {});
        expect(initial).toHaveLength(1);
        await refresh({ v: 1, accountId: 'alice', profile });
        expect(decryptMessages).toHaveBeenCalledTimes(1);

        await refresh({ v: 1, accountId: 'alice', profile: null });
        expect(Object.values(storage.getState().sessionMessages.s1?.messagesById ?? {})).toEqual([
            expect.objectContaining({
                id: initial[0].id, realID: row.id, seq: row.seq,
                text: `hello-${row.id}`,
                accountActor: { v: 1, accountId: 'alice', serverId: 'home-a', profile: null },
            }),
        ]);
        await refresh(null);
        expect(Object.values(storage.getState().sessionMessages.s1?.messagesById ?? {})).toEqual([
            expect.objectContaining({ id: initial[0].id, realID: row.id, accountActor: null }),
        ]);
        await refresh(null);
        expect(decryptMessages).toHaveBeenCalledTimes(1);
        messageActionReference = { ...messageActionReference!, observedRevision: 'revision-2' };
        await refresh(undefined);
        expect(Object.values(storage.getState().sessionMessages.s1.messagesById)[0]).toMatchObject({ accountActor: null, messageActionReference });
        messageActionReference = undefined;
        await refresh(undefined);
        expect(Object.values(storage.getState().sessionMessages.s1.messagesById)[0]).not.toHaveProperty('messageActionReference');
        expect(decryptMessages).toHaveBeenCalledTimes(1);
    });

    it('does not rediscover the known absence of thinking while refreshing transcript metadata', () => {
        storage.getState().applySessions([createSessionFixture({ id: 'metadata-store' })]);
        storage.getState().applyMessages('metadata-store', [{
            id: 'stored', localId: null, seq: 1, createdAt: 1, role: 'user', isSidechain: false,
            content: { type: 'text', text: 'unchanged' }, accountActor: null,
        }]);
        const before = storage.getState().sessionMessages['metadata-store'];
        expect(before.latestThinkingMessageId).toBeNull();
        const row = Object.values(before.messagesById)[0];
        let kindReads = 0;
        const kind = row.kind;
        Object.defineProperty(row, 'kind', { configurable: true, get: () => { kindReads++; return kind; } });
        storage.getState().applyMessages('metadata-store', [], { metadataUpdates: [{ id: 'stored', localId: null, accountActor: null }] });
        expect(kindReads).toBe(0);
        expect(storage.getState().sessionMessages['metadata-store']).toBe(before);
    });

    it('does not apply equal-revision metadata after a newer socket delivery advances its row during page decryption', async () => {
        const row = buildEncryptedApiMessage({ id: 'metadata-race', seq: 1, updatedAt: 100 });
        const newRow = buildEncryptedApiMessage({ id: 'new-content', seq: 2, updatedAt: 200 });
        const received = new Map([['s1', new Map([[row.id, 100]])]]);
        const applyMessageMetadata = vi.fn();
        const decryptMessages = vi.fn(async (rows: SessionMessageV1[]) => {
            // A newer authenticated socket update wins while this page yields.
            received.get('s1')!.set(row.id, 300);
            return rows.map((message) => buildTextContent(message));
        });
        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1', serverId: 'home-a', purpose: 'newer',
            page: { direction: 'newer', requestPath: '/messages', scope: 'main' },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: sessionEncryptionGetter({ decryptMessages }),
            request: async () => Response.json({ messages: [
                { ...row, accountActor: null, messageActionReference: { v: 1, sessionId: 's1', messageId: row.id, observedRevision: 'old' } },
                { ...newRow, accountActor: null },
            ] }),
            sessionReceivedMessages: received,
            applyMessages: () => {}, applyMessageMetadata,
            log: { log: () => {} },
        });
        expect(decryptMessages.mock.calls[0][0].map((message) => message.id)).toEqual([newRow.id]);
        expect(applyMessageMetadata).not.toHaveBeenCalled();
        expect(result.normalizedMessages).toEqual([expect.objectContaining({ id: newRow.id, accountActor: null })]);
        expect(received.get('s1')!.get(row.id)).toBe(300);
    });

    afterEach(() => {
        storage.setState(storage.getInitialState(), true);
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('replays an exact stale row once when equal updatedAt dedupe previously hid its correction', async () => {
        const message = buildEncryptedApiMessage({ id: 'stale-row', seq: 10, updatedAt: 2_010 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [message], hasMore: false, nextAfterSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const decryptMessages = vi.fn(async (messages: SessionMessageV1[]) => messages.map((candidate) =>
            buildTextContent(candidate, 'server-corrected text'),
        ));
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const sessionReceivedMessages = new Map<string, Map<string, number>>([
            ['s1', new Map([['stale-row', 2_010]])],
        ]);
        const runPage = (authoritativeUpdateMessageIds?: ReadonlySet<string>) => runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=9&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 9,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            authoritativeUpdateMessageIds,
            getSessionEncryption: sessionEncryptionGetter({ decryptMessages }),
            request,
            sessionReceivedMessages,
            applyMessages,
            log: { log: () => {} },
        });

        // Ordinary equal-timestamp deliveries stay deduped.
        await expect(runPage()).resolves.toMatchObject({ applied: 0, normalizedMessages: [] });
        expect(decryptMessages).not.toHaveBeenCalled();

        const result = await runPage(new Set(['stale-row']));
        expect(decryptMessages).toHaveBeenCalledTimes(1);
        expect(result.normalizedMessages).toEqual([
            expect.objectContaining({
                id: 'stale-row',
                isAuthoritativeUpdate: true,
                content: { type: 'text', text: 'server-corrected text' },
            }),
        ]);
        expect(applyMessages).toHaveBeenLastCalledWith('s1', [
            expect.objectContaining({ id: 'stale-row', isAuthoritativeUpdate: true }),
        ]);
    });

    it('keeps a newer socket correction when a marked stale page finishes decrypting later', async () => {
        const stalePageMessage = buildEncryptedApiMessage({ id: 'stale-row', seq: 10, updatedAt: 2_010 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [stalePageMessage], hasMore: false, nextAfterSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        type DecryptedPageMessage = {
            id: string;
            seq: number;
            localId: string | null;
            createdAt: number;
            content: unknown;
        };
        let releaseDecryption!: (messages: DecryptedPageMessage[]) => void;
        const pendingDecryption = new Promise<DecryptedPageMessage[]>((resolve) => {
            releaseDecryption = resolve;
        });
        const decryptMessages = vi.fn((_messages: SessionMessageV1[]) => pendingDecryption);
        const sessionReceivedMessages = new Map<string, Map<string, number>>([
            ['s1', new Map([['stale-row', 2_010]])],
        ]);
        const socketSession = {
            id: 's1',
            seq: 10,
            createdAt: 1_000,
            updatedAt: 2_011,
            active: true,
            activeAt: 1_000,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            encryptionMode: 'plain',
        } satisfies Session;
        let renderedRow = { text: 'socket-newer text', updatedAt: 2_011 };
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>((_sessionId, messages) => {
            const message = messages.find((candidate) => candidate.id === 'stale-row');
            if (message?.role === 'user') {
                renderedRow = {
                    text: message.content.text,
                    updatedAt: message.content.text === 'socket-newer text'
                        ? 2_011
                        : (stalePageMessage.updatedAt ?? stalePageMessage.createdAt),
                };
            }
        });
        const resolvedStaleIds = new Set<string>();

        const pendingResult = runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=9&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 9,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            authoritativeUpdateMessageIds: new Set(['stale-row']),
            getSessionEncryption: sessionEncryptionGetter({ decryptMessages }),
            request,
            sessionReceivedMessages,
            applyMessages,
            onNormalizedMessages: (messages) => {
                for (const message of messages) {
                    if (message.id === 'stale-row') resolvedStaleIds.add(message.id);
                }
            },
            log: { log: () => {} },
        });

        await vi.waitFor(() => expect(decryptMessages.mock.calls[0]?.[0]).toEqual([stalePageMessage]));

        // A newer same-row socket correction lands while the marked HTTP page
        // is still decrypting. The targeted refetch must not regress either
        // the live row or the page pipeline's currentness watermark.
        const socketUpdate = {
            updateData: {
                id: 'socket-update',
                seq: 10,
                createdAt: 2_011,
                body: {
                    t: 'message-updated' as const,
                    delivery: 'full' as const,
                    sid: 's1',
                    message: {
                        id: 'stale-row',
                        seq: 10,
                        localId: null,
                        sidechainId: null,
                        content: {
                            t: 'plain' as const,
                            v: { role: 'user', content: { type: 'text', text: 'socket-newer text' } },
                        },
                        createdAt: 1_010,
                        updatedAt: 2_011,
                    },
                },
            },
            getSessionEncryption: () => null,
            getSession: () => socketSession,
            applySessions: vi.fn(),
            fetchSessions: vi.fn(),
            applyMessages,
            isMutableToolCall: () => false,
            invalidateScmStatus: () => {},
            isSessionMessagesLoaded: () => true,
            isSessionFullContentConsumerActive: () => true,
            getSessionMaterializedMaxSeq: () => 10,
            markSessionMaterializedMaxSeq: vi.fn(),
            onMessageGapDetected: vi.fn(),
            sessionReceivedMessages,
        };
        await handleMessageUpdatedSocketUpdate(socketUpdate);
        releaseDecryption([buildTextContent(stalePageMessage, 'older page text')]);

        await expect(pendingResult).resolves.toMatchObject({ applied: 0, normalizedMessages: [] });
        expect(applyMessages).toHaveBeenLastCalledWith('s1', []);
        expect(renderedRow).toEqual({ text: 'socket-newer text', updatedAt: 2_011 });
        expect(sessionReceivedMessages.get('s1')?.get('stale-row')).toBe(2_011);
        expect(resolvedStaleIds).toEqual(new Set());
    });

    it('does not advance row currentness when applying a normalized page row is rejected', async () => {
        const message = buildEncryptedApiMessage({ id: 'apply-rejected', seq: 11, updatedAt: 2_012 });
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        await expect(runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=10&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 10,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: sessionEncryptionGetter({
                decryptMessages: async () => [buildTextContent(message)],
            }),
            request: async () => new Response(
                JSON.stringify({ messages: [message], hasMore: false, nextAfterSeq: null }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            sessionReceivedMessages,
            applyMessages: () => {
                throw new Error('reducer rejected page row');
            },
            log: { log: () => {} },
        })).rejects.toThrow('reducer rejected page row');

        expect(sessionReceivedMessages.get('s1')?.get('apply-rejected')).toBeUndefined();
    });

    it('abandons a response after session retirement before allocating page currentness or decrypting', async () => {
        const message = buildEncryptedApiMessage({ id: 'late-deleted-row', seq: 12, updatedAt: 2_013 });
        let sessionKnown = true;
        let releaseResponse!: (response: Response) => void;
        const heldResponse = new Promise<Response>((resolve) => {
            releaseResponse = resolve;
        });
        let markRequestStarted!: () => void;
        const requestStarted = new Promise<void>((resolve) => {
            markRequestStarted = resolve;
        });
        const decryptMessages = vi.fn(async (messages: SessionMessageV1[]) => messages.map((candidate) => buildTextContent(candidate)));
        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();

        const pendingResult = runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            isSessionKnown: () => sessionKnown,
            getSessionEncryption: sessionEncryptionGetter({ decryptMessages }),
            request: async () => {
                markRequestStarted();
                return await heldResponse;
            },
            sessionReceivedMessages,
            applyMessages,
            log: { log: () => {} },
        });

        await requestStarted;
        sessionKnown = false;
        releaseResponse(new Response(
            JSON.stringify({ messages: [message], hasMore: false, nextAfterSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        await expect(pendingResult).resolves.toMatchObject({
            applied: 0,
            normalizedMessages: [],
            skippedMissingSession: true,
        });
        expect(decryptMessages).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('drops a plugin transcript V1 after E2EE decryption without applying or advancing currentness', async () => {
        const message = {
            ...buildEncryptedApiMessage({ id: 'plugin-transcript', seq: 42 }),
            messageRole: 'agent' as const,
        };
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [message], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: sessionEncryptionGetter({
                decryptMessages: async () => [{
                    id: message.id,
                    seq: message.seq,
                    localId: null,
                    messageRole: 'agent',
                    createdAt: message.createdAt,
                    content: {
                        v: 1,
                        profile: 'pluginTranscriptV1',
                        owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                        snapshot: {
                            kind: 'status',
                            label: 'Report',
                            value: 'Ready',
                        },
                    },
                }],
            }),
            request,
            sessionReceivedMessages,
            applyMessages,
            log: { log: () => {} },
        });

        expect(result.applied).toBe(0);
        expect(result.normalizedMessages).toEqual([]);
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('drops current and future plugin transcript profiles from plain replay without applying or advancing currentness', async () => {
        const structuredPresentation = {
            v: 1,
            profile: 'pluginTranscriptV1',
            owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
            snapshot: {
                kind: 'status',
                label: 'Report',
                value: 'Ready',
            },
        } as const;
        const currentMessage = {
            ...buildEncryptedApiMessage({ id: 'plugin-transcript-plain', seq: 43 }),
            messageRole: 'agent' as const,
            content: { t: 'plain' as const, v: structuredPresentation },
        } as SessionMessageV1;
        const futureMessage = {
            ...buildEncryptedApiMessage({ id: 'plugin-transcript-future-plain', seq: 44 }),
            messageRole: 'agent' as const,
            content: {
                t: 'plain' as const,
                v: { ...structuredPresentation, profile: 'pluginTranscriptV2' },
            },
        } as SessionMessageV1;
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [currentMessage, futureMessage], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const getSessionEncryption = vi.fn(() => null);
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            sessionEncryptionMode: 'plain',
            getSessionEncryption,
            request,
            sessionReceivedMessages,
            applyMessages,
            log: { log: () => {} },
        });

        expect(getSessionEncryption).not.toHaveBeenCalled();
        expect(result.applied).toBe(0);
        expect(result.normalizedMessages).toEqual([]);
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('does not turn a future structured-presentation candidate into an unavailable UI fallback row', async () => {
        const message = {
            ...buildEncryptedApiMessage({ id: 'future-plugin-transcript', seq: 43 }),
            messageRole: 'agent' as const,
        };
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [message], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'initial',
            page: {
                direction: 'initial',
                requestPath: '/v1/sessions/s1/messages?limit=1',
                scope: 'main',
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: sessionEncryptionGetter({
                decryptMessages: async () => [{
                    id: message.id,
                    seq: message.seq,
                    localId: null,
                    messageRole: 'agent',
                    createdAt: message.createdAt,
                    content: {
                        v: 1,
                        profile: 'pluginTranscriptV2',
                        role: 'agent',
                        content: {
                            type: 'output',
                            data: {
                                type: 'assistant',
                                message: { role: 'assistant', content: 'legacy plugin payload' },
                            },
                        },
                        meta: {
                            happier: {
                                kind: 'acme.preview/preview-card.v1',
                                payload: { previewId: 'should-not-resolve' },
                            },
                        },
                    },
                }],
            }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            log: { log: () => {} },
        });

        expect(result.applied).toBe(0);
        expect(result.normalizedMessages).toEqual([]);
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
    });

    it('drops invalid and oversized structured presentations instead of creating unavailable transcript rows', async () => {
        const invalidRecords: readonly Readonly<{ id: string; content: unknown }>[] = [
            {
                id: 'field-plugin-transcript',
                content: {
                    v: 1,
                    profile: 'pluginTranscriptV1',
                    owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                    snapshot: {
                        kind: 'field',
                        label: 'Live setting',
                        control: { kind: 'text', settingId: 'report-setting' },
                    },
                },
            },
            {
                id: 'oversized-plugin-transcript',
                content: {
                    v: 1,
                    profile: 'pluginTranscriptV1',
                    owner: { pluginId: 'acme.preview', contributionLocalId: 'report-card' },
                    snapshot: { kind: 'text', text: 'x'.repeat(256 * 1024) },
                },
            },
        ];

        for (const record of invalidRecords) {
            const message = {
                ...buildEncryptedApiMessage({ id: record.id, seq: 44 }),
                messageRole: 'agent' as const,
            };
            const request = vi.fn(async () => new Response(
                JSON.stringify({ messages: [message], hasMore: false }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ));
            const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();

            const result = await runSessionMessagesPagePipeline({
                sessionId: 's1',
                purpose: 'initial',
                page: {
                    direction: 'initial',
                    requestPath: '/v1/sessions/s1/messages?limit=1',
                    scope: 'main',
                    limit: 1,
                },
                lifecyclePolicy: 'emit',
                getSessionEncryption: sessionEncryptionGetter({
                    decryptMessages: async () => [{
                        id: message.id,
                        seq: message.seq,
                        localId: null,
                        messageRole: 'agent',
                        createdAt: message.createdAt,
                        content: record.content,
                    }],
                }),
                request,
                sessionReceivedMessages: new Map<string, Map<string, number>>(),
                applyMessages,
                log: { log: () => {} },
            });

            expect(result.applied).toBe(0);
            expect(result.normalizedMessages).toEqual([]);
            expect(applyMessages).toHaveBeenCalledWith('s1', []);
        }
    });

    it('preserves older-page decrypt order, sidechain metadata, and pre-apply normalized callback semantics', async () => {
        const newest = buildEncryptedApiMessage({ id: 'm100', seq: 100 });
        const oldest = buildEncryptedApiMessage({ id: 'm99', seq: 99 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [newest, oldest],
                hasMore: true,
                nextBeforeSeq: 98,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));

        const decryptMessages = vi.fn(async (messages: SessionMessageV1[]) =>
            messages.map((message) => buildTextContent(message)),
        );
        const applyMessages = vi.fn<(sessionId: string, messages: NormalizedMessage[]) => void>();
        const callOrder: string[] = [];
        const onNormalizedMessages = vi.fn((messages: NormalizedMessage[]) => {
            callOrder.push(`normalized:${messages.map((message) => message.id).join(',')}`);
        });
        applyMessages.mockImplementation((_sessionId, messages) => {
            callOrder.push(`apply:${messages.map((message) => message.id).join(',')}`);
        });

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'older',
            page: {
                direction: 'older',
                requestPath: '/v1/sessions/s1/messages?beforeSeq=101&limit=2&scope=sidechain&sidechainId=tool_task_1',
                scope: 'sidechain',
                sidechainId: 'tool_task_1',
                beforeSeq: 101,
                limit: 2,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: sessionEncryptionGetter({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onNormalizedMessages,
            log: { log: () => {} },
        });

        expect(request).toHaveBeenCalledWith('/v1/sessions/s1/messages?beforeSeq=101&limit=2&scope=sidechain&sidechainId=tool_task_1');
        expect(decryptMessages.mock.calls[0]?.[0].map((message) => message.id)).toEqual(['m99', 'm100']);
        expect(callOrder).toEqual(['normalized:m99,m100', 'apply:m99,m100']);
        expect(applyMessages.mock.calls[0]?.[1]).toEqual([
            expect.objectContaining({ id: 'm99', seq: 99, isSidechain: true, sidechainId: 'tool_task_1' }),
            expect.objectContaining({ id: 'm100', seq: 100, isSidechain: true, sidechainId: 'tool_task_1' }),
        ]);
        expect(result).toMatchObject({
            applied: 2,
            appliedMessageIds: ['m99', 'm100'],
            appliedSeqs: [99, 100],
            rawSeqs: [100, 99],
            page: {
                hasMore: true,
                nextBeforeSeq: 98,
            },
        });
    });

    it('uses an explicit target-window purpose and lifecycle policy instead of treating newer-side target pages as live-tail newer pages', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const lifecycle = buildEncryptedApiMessage({ id: 'm101', seq: 101 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({
                messages: [lifecycle],
                nextAfterSeq: 101,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const decryptMessages = vi.fn(async (messages: SessionMessageV1[]) =>
            messages.map((message) => buildLifecycleContent(message)),
        );
        const onTaskLifecycleEvent = vi.fn();
        const applyMessages = vi.fn();

        const result = await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'target-window',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=100&limit=1&scope=main',
                scope: 'main',
                sidechainId: null,
                afterSeq: 100,
                limit: 1,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: sessionEncryptionGetter({ decryptMessages }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onTaskLifecycleEvent,
            log: { log: () => {} },
        });

        expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledWith('s1', []);
        expect(result).toMatchObject({
            applied: 0,
            appliedMessageIds: [],
            rawSeqs: [101],
        });

        const events = syncPerformanceTelemetry.snapshot().events;
        const requestEvent = events.find((event) => event.name === 'sync.sessions.messages.request');
        expect(requestEvent?.fields.targetWindow).toBe(1);
        expect(requestEvent?.fields.newer ?? 0).toBe(0);
    });

    it('preserves authenticated recovered-history chronology without emitting live lifecycle effects', async () => {
        const recoveredLifecycle = buildEncryptedApiMessage({
            id: 'history-lifecycle',
            seq: 101,
            sourceCreatedAt: 100,
            sourceUpdatedAt: 200,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
        const recoveredText = buildEncryptedApiMessage({
            id: 'history-text',
            seq: 102,
            sourceCreatedAt: 300,
            sourceUpdatedAt: 400,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [recoveredLifecycle, recoveredText], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn();
        const onTaskLifecycleEvent = vi.fn();

        await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=100&limit=1',
                scope: 'main',
                sidechainId: null,
                afterSeq: 100,
                limit: 1,
            },
            lifecyclePolicy: 'emit',
            getSessionEncryption: sessionEncryptionGetter({
                decryptMessages: async (messages: SessionMessageV1[]) => messages.map((message) => (
                    message.id === recoveredLifecycle.id
                        ? buildLifecycleContent(message)
                        : buildTextContent(message)
                )),
            }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            onTaskLifecycleEvent,
            log: { log: () => {} },
        });

        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            id: 'history-text',
            seq: 102,
            createdAt: 1_102,
            sourceCreatedAt: 300,
            sourceUpdatedAt: 400,
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
            },
        });
        expect(onTaskLifecycleEvent).not.toHaveBeenCalled();
    });

    it('preserves a server-issued message action reference on the normalized transcript message', async () => {
        const messageActionReference = {
            v: 1,
            sessionId: 's1',
            messageId: 'actionable-message',
            observedRevision: 'revision-7',
        } as const;
        const actionable = buildEncryptedApiMessage({
            id: 'actionable-message',
            seq: 103,
            messageActionReference,
        });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [actionable], hasMore: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const applyMessages = vi.fn();

        await runSessionMessagesPagePipeline({
            sessionId: 's1',
            purpose: 'newer',
            page: {
                direction: 'newer',
                requestPath: '/v1/sessions/s1/messages?afterSeq=102&limit=1',
                scope: 'main',
                sidechainId: null,
                afterSeq: 102,
                limit: 1,
            },
            lifecyclePolicy: 'suppress',
            getSessionEncryption: sessionEncryptionGetter({
                decryptMessages: async (messages: SessionMessageV1[]) => messages.map((message) => buildTextContent(message)),
            }),
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            log: { log: () => {} },
        });

        expect(applyMessages).toHaveBeenCalledWith('s1', [expect.objectContaining({
            id: 'actionable-message',
            messageActionReference,
        })]);
    });
});
