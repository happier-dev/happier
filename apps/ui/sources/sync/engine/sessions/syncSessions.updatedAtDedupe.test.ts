import { type SessionMessageV1 } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as platformCrypto from 'rn-encryption';
import { createDeferred } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { fetchAndApplyMessages } from './syncSessions';
import { advanceSessionReceivedMessageCurrentness } from "@happier-dev/session-core/transcript";

let encryption: Encryption;

async function buildApiMessage(params: { id: string; seq: number; updatedAt: number }): Promise<SessionMessageV1> {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: null,
        content: { t: 'encrypted', c: await encryption.getSessionEncryption('s1')!.encryptRawRecord({
            role: 'user', content: { type: 'text', text: `hello-${params.updatedAt}` },
        }) },
        createdAt: 1_000 + params.seq,
        updatedAt: params.updatedAt,
    };
}

function buildPlainApiMessage(params: { id: string; seq: number; text: string }): SessionMessageV1 {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        sidechainId: null,
        content: {
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text: params.text } },
        },
        createdAt: 1_000 + params.seq,
        updatedAt: 2_000 + params.seq,
    };
}

describe('fetchAndApplyMessages (updatedAt dedupe)', () => {
    beforeEach(async () => {
        storage.setState(storage.getInitialState(), true);
        storage.getState().applySessions([
            createSessionFixture({ id: 's1', encryptionMode: 'e2ee' }),
            createSessionFixture({ id: 's_plain', encryptionMode: 'plain' }),
        ]);
        encryption = await Encryption.create(new Uint8Array(32).fill(1));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        await encryption.initializeSessions(new Map([['s1', new Uint8Array(32).fill(2)]]));
    });

    function observeAppliedMessages() {
        return vi.fn((id: string, messages: NormalizedMessage[]) => storage.getState().applyMessages(id, messages));
    }

    function observeMessagesLoaded() {
        return vi.fn((id: string) => storage.getState().applyMessagesLoaded(id));
    }

    function delayPlatformDecryption() {
        const started = createDeferred<void>();
        const release = createDeferred<void>();
        const originalDecrypt = platformCrypto.decryptAsyncAES;
        // Delay real crypto at its native SDK completion boundary, not the internal decoder.
        vi.spyOn(platformCrypto, 'decryptAsyncAES').mockImplementationOnce(async (...args) => {
            const plaintext = await originalDecrypt(...args);
            started.resolve();
            await release.promise;
            return plaintext;
        });
        return { started: started.promise, release: () => release.resolve() };
    }

    afterEach(() => {
        vi.restoreAllMocks();
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('re-applies a previously-seen message when updatedAt increases', async () => {
        const applyMessages = observeAppliedMessages();
        const markMessagesLoaded = observeMessagesLoaded();
        const request = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    messages: [await buildApiMessage({ id: 'm1', seq: 1, updatedAt: 3_000 })],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const decryptMessages = vi.spyOn(encryption.getSessionEncryption('s1')!, 'decryptMessages');

        const sessionReceivedMessages = new Map<string, Map<string, number>>();
        sessionReceivedMessages.set('s1', new Map([['m1', 2_000]]));

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        await fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: id => encryption.getSessionEncryption(id),
            request,
            sessionReceivedMessages,
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        expect(decryptMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]?.id).toBe('m1');
        expect(markMessagesLoaded).toHaveBeenCalledTimes(1);

        const events = syncPerformanceTelemetry.snapshot().events;
        const requestEvent = events.find((event) => event.name === 'sync.sessions.messages.request');
        expect(requestEvent?.fields.initial).toBe(1);
        expect(requestEvent?.fields.scopeMain).toBe(1);
        const responseJsonEvent = events.find((event) => event.name === 'sync.sessions.messages.responseJson');
        expect(responseJsonEvent?.fields.status).toBe(200);
        const parseResponseEvent = events.find((event) => event.name === 'sync.sessions.messages.parseResponse');
        expect(parseResponseEvent?.fields.initial).toBe(1);
        const pageEvent = events.find((event) => event.name === 'sync.sessions.messages.page');
        expect(pageEvent?.fields.fetched).toBe(1);
        const dedupeEvent = events.find((event) => event.name === 'sync.sessions.messages.dedupe');
        expect(dedupeEvent?.fields.toDecrypt).toBe(1);
        expect(dedupeEvent?.fields.skipped).toBe(0);
        const decryptEvent = events.find((event) => event.name === 'sync.sessions.messages.decrypt');
        expect(decryptEvent?.fields.messages).toBe(1);
        const normalizeEvent = events.find((event) => event.name === 'sync.sessions.messages.normalize');
        expect(normalizeEvent?.fields.decrypted).toBe(1);
        const applyEvent = events.find((event) => event.name === 'sync.sessions.messages.apply');
        expect(applyEvent?.fields.normalized).toBe(1);
    });

    it('keeps a newer socket watermark when an initial snapshot finishes decrypting later', async () => {
        const stalePageMessage = await buildApiMessage({ id: 'm1', seq: 1, updatedAt: 2_010 });
        const request = vi.fn(async () => new Response(
            JSON.stringify({ messages: [stalePageMessage] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        const delayedDecryption = delayPlatformDecryption();
        const sessionReceivedMessages = new Map<string, Map<string, number>>([
            ['s1', new Map([['m1', 2_009]])],
        ]);
        const applyMessages = observeAppliedMessages();
        const markMessagesLoaded = observeMessagesLoaded();

        const pendingResult = fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: id => encryption.getSessionEncryption(id),
            request,
            sessionReceivedMessages,
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        await delayedDecryption.started;
        advanceSessionReceivedMessageCurrentness(sessionReceivedMessages, 's1', 'm1', 2_011);
        delayedDecryption.release();

        await pendingResult;

        expect(applyMessages).toHaveBeenLastCalledWith('s1', []);
        expect(sessionReceivedMessages.get('s1')?.get('m1')).toBe(2_011);
        expect(markMessagesLoaded).toHaveBeenCalledWith('s1');
    });

    it('drops an initial snapshot that loses session visibility during decryption', async () => {
        const message = await buildApiMessage({ id: 'deleted-during-decrypt', seq: 2, updatedAt: 2_012 });
        const delayedDecryption = delayPlatformDecryption();
        const applyMessages = observeAppliedMessages();
        const markMessagesLoaded = observeMessagesLoaded();
        const onMessagesPage = vi.fn();
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        const pendingResult = fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: id => encryption.getSessionEncryption(id),
            isSessionKnown: id => Boolean(storage.getState().sessions[id]),
            request: async () => new Response(
                JSON.stringify({ messages: [message] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            sessionReceivedMessages,
            applyMessages,
            markMessagesLoaded,
            onMessagesPage,
            log: { log: () => {} },
        });

        await delayedDecryption.started;
        storage.getState().deleteSession('s1');
        delayedDecryption.release();

        await pendingResult;

        expect(onMessagesPage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markMessagesLoaded).not.toHaveBeenCalled();
        expect(sessionReceivedMessages.get('s1')).toBeUndefined();
    });

    it('does not mark a transcript loaded after its page apply loses session visibility', async () => {
        const message = await buildApiMessage({ id: 'deleted-after-apply', seq: 3, updatedAt: 2_013 });
        const applyMessages = vi.fn((id: string, messages: NormalizedMessage[]) => {
            storage.getState().applyMessages(id, messages);
            queueMicrotask(() => {
                storage.getState().deleteSession(id);
            });
        });
        const markMessagesLoaded = observeMessagesLoaded();

        await fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: id => encryption.getSessionEncryption(id),
            isSessionKnown: id => Boolean(storage.getState().sessions[id]),
            request: async () => new Response(
                JSON.stringify({ messages: [message] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markMessagesLoaded).not.toHaveBeenCalled();
    });

    it('does not advance row currentness when the page application does not commit', async () => {
        const message = await buildApiMessage({ id: 'apply-rejected', seq: 2, updatedAt: 2_012 });
        const sessionReceivedMessages = new Map<string, Map<string, number>>();

        await expect(fetchAndApplyMessages({
            sessionId: 's1',
            getSessionEncryption: id => encryption.getSessionEncryption(id),
            request: async () => new Response(
                JSON.stringify({ messages: [message] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
            sessionReceivedMessages,
            applyMessages: (id, messages) => {
                storage.getState().applyMessages(id, messages);
                throw new Error('page application did not commit');
            },
            markMessagesLoaded: vi.fn(),
            log: { log: () => {} },
        })).rejects.toThrow('page application did not commit');

        expect(sessionReceivedMessages.get('s1')?.get('apply-rejected')).toBeUndefined();
    });

    it('applies plaintext message pages without touching the encryption registry', async () => {
        const applyMessages = observeAppliedMessages();
        const markMessagesLoaded = observeMessagesLoaded();
        const getSessionEncryption = vi.fn(() => null);
        const request = vi.fn(async () =>
            new Response(
                JSON.stringify({
                    messages: [buildPlainApiMessage({ id: 'm_plain', seq: 1, text: 'hello plain' })],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await fetchAndApplyMessages({
            sessionId: 's_plain',
            sessionEncryptionMode: 'plain',
            getSessionEncryption,
            request,
            sessionReceivedMessages: new Map<string, Map<string, number>>(),
            applyMessages,
            markMessagesLoaded,
            log: { log: () => {} },
        });

        expect(getSessionEncryption).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            id: 'm_plain',
            role: 'user',
            seq: 1,
        });
        expect(markMessagesLoaded).toHaveBeenCalledWith('s_plain');
    });
});
