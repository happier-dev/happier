import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { Encryption } from '@/sync/encryption/encryption';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { encodeBase64 } from '@/encryption/base64';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import type { SessionMessagesWindowState } from '@/sync/runtime/sessionMessagesWindowState';
import { AppSessionTranscriptSourceProvider } from './appSessionTranscriptSource';
import { useSessionTranscriptSource } from './SessionTranscriptSourceContext';

afterEach(standardCleanup);
let home: Awaited<ReturnType<typeof serveSessionActionHome>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; });

describe('source-owned Find history paging', () => {
    it('continues both frontiers of a route-created encrypted window through the real decrypt and reducer pipeline', async () => {
        const id = 'find-encrypted-window';
        const secret = new Uint8Array(32).fill(7);
        const dataKey = new Uint8Array(32).fill(8);
        const encryption = await Encryption.create(secret);
        await encryption.initializeSessions(new Map([[id, dataKey]]));
        const reader = encryption.getSessionEncryption(id)!;
        const { ownerMetadata: _ownerMetadata, ...facts } = createPlainSessionCurrentProjectionRecordFixture({ id, seq: 102 });
        const session = SessionCurrentProjectionRecordV1Schema.parse({
            ...facts, encryptionMode: 'e2ee', metadataLayoutVersion: 0,
            metadata: await reader.encryptRaw({ path: '/workspace', host: 'fixture' }),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(dataKey)),
        });
        const request = vi.fn<(url: URL) => Promise<Response>>();
        home = await serveSessionActionHome({
            homes: [{ key: 'owner', serverUrl: 'https://find-history.test', accountId: 'account-a', accountMode: 'e2ee',
                credentials: { token: createAccountTokenForTests('account-a'), secret: encodeBase64(secret, 'base64url') },
                encryptionCurrentness: () => ({ mode: 'e2ee', version: 1, updatedAt: 1,
                    signingKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(secret)),
                    contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(encryption.contentDataKey),
                    recipientEnvelopeReadiness: { status: 'available' },
                }),
            }],
            route: ({ path, url }) => {
                if (path === `/v1/sessions/${id}/messages`) return request(url);
                if (path === `/v2/sessions/${id}`) return Response.json({ session });
                if (path === '/v2/sessions' || path === '/v2/sessions/active')
                    return Response.json({ sessions: [session], nextCursor: null, hasNext: false });
                // A fresh encrypted Account has no Project rows; plain row content is invalid here.
                if (path === '/v1/account/project-rows/list')
                    return Response.json({ status: 'listed', coverage: 'complete', rows: [] });
                return undefined;
            },
        });
        const { sync } = await import('@/sync/syncEngine');
        const previous = storage.getState();
        // Admit the served encrypted record through the production route reader.
        expect(await sync.ensureSessionVisibleForMessageRoute(id, {
            serverId: home.serverId, hydrateMessages: false, includeTurnsProjection: false,
        })).toMatchObject({ kind: 'available' });
        const owner = sync as unknown as {
            setSessionTargetWindowState(id: string, state: SessionMessagesWindowState): void;
        };
        const previousWindow = sync.getSessionTargetWindowState(id);
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
            await act(async () => { expect(await hook.getCurrent().source.history.loadTargetWindow?.({ kind: 'route-message-id', routeMessageId: 'server:m100', seqHint: 100 })).toMatchObject({ status: 'loaded' }); });
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
            storage.setState(previous);
        }
    });
});
