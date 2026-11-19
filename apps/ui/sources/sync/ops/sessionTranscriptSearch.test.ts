import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSearchQuery } from '@happier-dev/protocol';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { encodeBase64 } from '@/encryption/base64';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { resetScopedSessionDataKeyCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import type { ResolvedServerSessionRpcContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { storage } from '@/sync/domains/state/storageStore';
import { searchSessionTranscript } from './sessionTranscriptSearch';

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: Parameters<typeof fetch>) => fetchMock(...args),
}));

const session = {
    id: 'saved', seq: 3, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
    archivedAt: null, metadata: '{}', metadataVersion: 1, agentState: null,
    agentStateVersion: 0, pendingCount: 0, pendingVersion: 0, dataEncryptionKey: null,
};
const user = (text: string) => ({ role: 'user', content: { type: 'text', text } });
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

async function context(encrypted = false) {
    const encryption = await createEncryptionFromAuthCredentials(encrypted
        ? { token: 'test-token', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') }
        : { token: 'test-token' });
    return {
        scope: 'scoped', targetServerId: 'test-server', targetServerUrl: 'https://transcripts.example.test',
        token: 'test-token', targetAccountId: 'test-account', credentialScopeKey: 'test-scope',
        timeoutMs: 30_000, encryption,
    } satisfies Extract<ResolvedServerSessionRpcContext, { scope: 'scoped' }>;
}

afterEach(async () => {
    fetchMock.mockReset();
    resetScopedSessionDataKeyCacheForTests();
    await resetServerReachabilitySupervisors();
});

describe('searchSessionTranscript', () => {
    it.each([false, true])('searches every saved page with real decryption (%s), AND terms and late exclusions', async (encrypted) => {
        const ctx = await context(encrypted);
        if (encrypted) await ctx.encryption.initializeSessions(new Map([['saved', null]]));
        const cipher = ctx.encryption.getSessionEncryption('saved');
        const texts = ['Drag handles do not work.', 'on project headings', 'umbrella pigs'];
        const rows = await Promise.all(texts.map(async (text, index) => ({
            id: `message-${index}`, seq: index + 1, localId: null, messageRole: 'user', createdAt: 1,
            content: encrypted
                ? { t: 'encrypted', c: await cipher!.encryptRaw(user(text)) }
                : { t: 'plain', v: user(text) },
        })));
        const pages: number[] = [];
        fetchMock.mockImplementation(async (url) => {
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v2/sessions/')) return json({
                session: { ...session, encryptionMode: encrypted ? 'e2ee' : 'plain' },
            });
            if (parsed.pathname.endsWith('/messages')) {
                const after = Number(parsed.searchParams.get('afterSeq'));
                pages.push(after);
                return json({ messages: rows.slice(after, after + 1), nextAfterSeq: after < rows.length ? after + 1 : null });
            }
            return json({ status: 'ok' });
        });
        const messagesBefore = storage.getState().sessionMessages;
        const search = (query: string) => searchSessionTranscript({
            context: ctx, sessionId: 'saved', query: parseSearchQuery(query),
            initialText: 'repair', signal: new AbortController().signal,
        });
        expect(await search('repair "Drag handles" "project headings"')).toEqual({ matched: true, excluded: false });
        expect(pages).toEqual([0, 1]); // No exclusion: the match settles without fetching the rest.
        pages.length = 0;
        expect(await search('repair "Drag handles" "project headings" -"umbrella pigs"')).toEqual({ matched: false, excluded: true });
        expect(pages).toEqual([0, 1, 2]);
        expect(await search('"Drag handles" -"umbrella dancing pigs"')).toEqual({ matched: true, excluded: false });
        expect(await search('"Drag handles project headings"')).toEqual({ matched: false, excluded: false });
        expect(storage.getState().sessionMessages).toBe(messagesBefore);
    });

    it('reports transport errors instead of declaring an incomplete negative search successful', async () => {
        const ctx = await context();
        fetchMock.mockImplementation(async (url) => String(url).includes('/messages')
            ? new Response('', { status: 503 })
            : json({ session: { ...session, encryptionMode: 'plain' } }));
        await expect(searchSessionTranscript({
            context: ctx, sessionId: 'saved', query: parseSearchQuery('-umbrella'),
            initialText: 'repair', signal: new AbortController().signal,
        })).rejects.toThrow('503');
    });

    it('respects the client encryption requirement before reading plaintext messages', async () => {
        const ctx = await context();
        const previousSettings = storage.getState().settings;
        const messageReads: string[] = [];
        fetchMock.mockImplementation(async (url) => {
            if (String(url).includes('/messages')) messageReads.push(String(url));
            return json({ session: { ...session, encryptionMode: 'plain' } });
        });
        storage.setState({ settings: { ...previousSettings, clientEncryptionRequirementLocalV1: 'require_e2ee' } });
        try {
            await expect(searchSessionTranscript({
                context: ctx, sessionId: 'saved', query: parseSearchQuery('needle'),
                initialText: '', signal: new AbortController().signal,
            })).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
            expect(messageReads).toEqual([]);
        } finally {
            storage.setState({ settings: previousSettings });
        }
    });

    it('cancels the response body after headers without reading another page', async () => {
        const ctx = await context();
        const controller = new AbortController();
        let bodyStarted!: () => void;
        const bodyReady = new Promise<void>((resolve) => { bodyStarted = resolve; });
        fetchMock.mockImplementation(async (url) => {
            if (String(url).includes('/messages')) {
                const body = new ReadableStream<Uint8Array>({ start() { bodyStarted(); } });
                return new Response(body, { status: 200 });
            }
            return json({ session: { ...session, encryptionMode: 'plain' } });
        });
        const searching = searchSessionTranscript({
            context: ctx, sessionId: 'saved', query: parseSearchQuery('needle'),
            initialText: '', signal: controller.signal,
        });
        const rejected = expect(searching).rejects.toMatchObject({ name: 'AbortError' });
        await bodyReady;
        controller.abort();
        await rejected;
    });
});
