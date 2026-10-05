import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { Encryption } from '@/sync/encryption/encryption';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { SessionMessagesEncryption } from '@/sync/engine/sessions/sessionMessagesPagePipeline';
import type { SessionMessagesWindowState } from '@/sync/runtime/sessionMessagesWindowState';
import { AppSessionTranscriptSourceProvider } from './appSessionTranscriptSource';
import { useSessionTranscriptSource } from './SessionTranscriptSourceContext';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/getSyncSingleton', async () => (await import('@/dev/testkit/harness/syncSingletonLoader')).createSyncSingletonLoaderMock());
// HTTP and scoped credential persistence are the real external boundaries.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: 'hdr.eyJzdWIiOiJhY2NvdW50LWEifQ.sig' }),
    } });
});
vi.mock('@/sync/api/session/apiSocket', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/api/session/apiSocket')>();
    return { ...original, apiSocket: { ...original.apiSocket, request } };
});

beforeEach(async () => {
    request.mockReset();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/v1/auth/ping') || url.endsWith('/health')) return Response.json({ ok: true });
        return request(input, init);
    });
    await loadSyncSingletonForTests();
});
afterEach(() => { vi.unstubAllGlobals(); standardCleanup(); });

describe('source-owned Find history paging', () => {
    it('continues both frontiers of a route-created encrypted window through the real decrypt and reducer pipeline', async () => {
        const { sync } = await import('@/sync/syncEngine');
        const previous = storage.getState();
        const id = 'find-encrypted-window';
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        await encryption.initializeSessions(new Map([[id, new Uint8Array(32).fill(8)]]));
        const reader = encryption.getSessionEncryption(id)!;
        // Seed the singleton's actual encryption and known-Session lifecycle.
        const owner = sync as unknown as {
            encryption: { getSessionEncryption(id: string): SessionMessagesEncryption | null };
            activeServerSessionIds: Set<string>; hasFetchedSessionsSnapshotForActiveServer: boolean;
            setSessionTargetWindowState(id: string, state: SessionMessagesWindowState): void;
        };
        const previousEncryption = owner.encryption;
        const previousIds = owner.activeServerSessionIds;
        const previousFetched = owner.hasFetchedSessionsSnapshotForActiveServer;
        const previousWindow = sync.getSessionTargetWindowState(id);
        owner.encryption = encryption;
        owner.activeServerSessionIds = new Set([id]);
        owner.hasFetchedSessionsSnapshotForActiveServer = true;
        storage.getState().applySessions([createSessionFixture({ id, serverId: getActiveServerSnapshot().serverId, encryptionMode: 'e2ee', encryptedContentAvailability: 'ready', metadata: null })]);
        const encryptedRow = async (seq: number, text: string) => ({
            id: `m${seq}`, seq, localId: null, sidechainId: null, createdAt: seq, updatedAt: seq,
            content: { t: 'encrypted', c: await reader.encryptRaw({ role: 'user', content: { type: 'text', text } }) },
        });
        request.mockResolvedValueOnce(Response.json({ messages: [await encryptedRow(100, 'target')], hasMore: true, nextBeforeSeq: 100 }))
            .mockResolvedValueOnce(Response.json({ messages: [await encryptedRow(101, 'newer loaded')], hasMore: true, nextAfterSeq: 101 }));
        const hook = await renderHook(() => {
            const source = useSessionTranscriptSource();
            return { source, history: source.history.useState(), messages: source.useMessagesById() };
        }, { wrapper: (props) => <AppSessionTranscriptSourceProvider sessionId={id}>{props.children}</AppSessionTranscriptSourceProvider> });
        try {
            await act(async () => { await hook.getCurrent().source.history.loadTargetWindow?.({ kind: 'route-message-id', routeMessageId: 'server:m100', seqHint: 100 }); });
            const windowId = sync.getSessionTargetWindowState(id).windowId;
            // A failed ciphertext must remain retryable without certifying or advancing its frontier.
            request.mockResolvedValueOnce(Response.json({ messages: [{ ...await encryptedRow(99, 'unreadable'), content: { t: 'encrypted', c: 'unreadable-ciphertext' } }], hasMore: false, nextBeforeSeq: null }));
            await act(async () => { expect(await hook.getCurrent().source.history.loadFindPage?.('older')).toMatchObject({ status: 'retryable_error', hasMore: true }); });
            expect(hook.getCurrent().history).toMatchObject({ hasOlder: true, targetWindow: { olderCursor: 100 } });
            request.mockResolvedValueOnce(Response.json({ messages: [await encryptedRow(99, 'older needle')], hasMore: false, nextBeforeSeq: null }));
            await act(async () => { expect(await hook.getCurrent().source.history.loadFindPage?.('older')).toMatchObject({ status: 'no_more', loaded: 1, hasMore: false }); });
            expect(new URL(String(request.mock.calls[2][0]), 'https://sync.test').searchParams.get('beforeSeq')).toBe('100');
            expect(new URL(String(request.mock.calls[3][0]), 'https://sync.test').searchParams.get('beforeSeq')).toBe('100');
            expect(sync.getSessionTargetWindowState(id).windowId).toBe(windowId);
            expect(Object.values(hook.getCurrent().messages)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'user-text', text: 'older needle' })]));
            request.mockResolvedValueOnce(Response.json({ messages: [await encryptedRow(102, 'newer needle')], hasMore: false, nextAfterSeq: null }));
            await act(async () => { await hook.getCurrent().source.history.loadFindPage?.('newer'); });
            expect(new URL(String(request.mock.calls[4][0]), 'https://sync.test').searchParams.get('afterSeq')).toBe('101');
            expect(hook.getCurrent().history).toMatchObject({ hasOlder: false, hasNewer: false });
            expect(Object.values(hook.getCurrent().messages)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'user-text', text: 'newer needle' })]));
        } finally {
            await hook.unmount();
            owner.setSessionTargetWindowState(id, previousWindow);
            owner.encryption = previousEncryption; owner.activeServerSessionIds = previousIds; owner.hasFetchedSessionsSnapshotForActiveServer = previousFetched;
            storage.setState(previous);
        }
    });
});
