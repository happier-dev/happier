import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import * as routes from '@/sync/domains/transfers/runtime/transferRouteCache';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import { createDeferred, createSessionFixture } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const h = await createConcurrentCacheNetworkHarness('cache-routing');
beforeEach(() => h.reset());
afterEach(() => h.cleanup());
afterAll(() => h.dispose());

const rows = () => h.storage.getState().sessionListRowsByServerId[h.homeB.id];
const machines = () => h.storage.getState().machineListByServerId[h.homeB.id];
const route = (serverId = h.homeB.id, remoteMachineId = 'machine-b') => ({ serverId, remoteMachineId });

describe('concurrent session cache socket routing', () => {



    it('consumes ongoing secondary Home bodies and stream checkpoints through the real Sync owner without hydrating foreign same-id transcripts', async () => {
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { UpdateContainerSchema } = await import('@happier-dev/protocol/updates');
        const id = 'secondary-live';
        h.setSessions(h.homeB, [h.session({ id, metadata: { path: '/repo', host: 'host', machineId: 'machine-b' } })]);
        h.setMachines(h.homeB, [h.machine(h.homeB, 'machine-b')]);
        h.setSessions(h.homeA, [h.session({ id, metadata: { path: '/foreign', host: 'host', machineId: 'machine-a' } })]);
        h.setResponder(async input => {
            const path = new URL(String(input)).pathname;
            return path.endsWith('/messages') ? Response.json({ messages: [], hasMore: false })
                : path.endsWith('/pending') ? Response.json({ pending: [], pendingVersion: 0 }) : null;
        });
        await h.start(); await h.ready();
        const release = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        const texts = () => Object.values(h.storage.getState().sessionMessages[id]?.messagesMap ?? {})
            .flatMap(message => message.kind === 'agent-text' ? [message.text] : []);
        const record = (text: string) => ({ role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'message', message: text } } });
        try {
            await vi.waitFor(() => expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeB.id));
            const shellReads = h.requests(`/v2/sessions/${id}`).length;
            h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'secondary-full', seq: 1, createdAt: 2,
                body: { t: 'new-message', sid: id, delivery: 'full', message: { id: 'message-live', seq: 1, localId: null,
                    createdAt: 2, updatedAt: 2, content: { t: 'plain', v: record('secondary durable text') } } } }));
            await vi.waitFor(() => expect(texts()).toContain('secondary durable text'));
            h.socket().trigger('ephemeral', { type: 'transcript-stream-segment', sessionId: id,
                message: { localId: 'stream-live', messageRole: 'agent', tick: 1, createdAt: 3, updatedAt: 3,
                    content: { t: 'plain', v: { ...record('secondary streaming text'), meta: { happierStreamSegmentV1: {
                        v: 1, segmentKind: 'assistant', segmentLocalId: 'stream-live', segmentState: 'streaming', startedAtMs: 3, updatedAtMs: 3,
                    } } } } } });
            await vi.waitFor(() => expect(texts()).toContain('secondary streaming text'));
            expect(h.requests(`/v2/sessions/${id}`).length).toBe(shellReads);
            const secondarySession = h.storage.getState().sessions[id];
            if (!secondarySession) throw new Error('Expected the opened secondary carrier');
            h.storage.getState().applySessions([{ ...secondarySession, serverId: h.homeA.id,
                metadata: { ...secondarySession.metadata, path: '/foreign', host: 'host', machineId: 'machine-a' },
            }]);
            expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeA.id);
            const foreignMessages = h.storage.getState().sessionMessages[id];
            h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'secondary-foreign', seq: 2, createdAt: 4,
                body: { t: 'new-message', sid: id, delivery: 'full', message: { id: 'foreign-frame', seq: 2, localId: null,
                    createdAt: 4, updatedAt: 4, content: { t: 'plain', v: record('must stay foreign') } } } }));
            await Promise.resolve(); await Promise.resolve();
            expect(h.storage.getState().sessionMessages[id]).toBe(foreignMessages);
            expect(texts()).not.toContain('must stay foreign');
            release();
            const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
            useVoiceTargetStore.setState({ primaryActionSessionAddress: null, lastFocusedSessionAddress: null });
            const { readMountedSessionRealtimeTranscriptConsumerSessionIds } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
            expect(readMountedSessionRealtimeTranscriptConsumerSessionIds(h.homeB.id)).not.toContain(id);
            const { isSessionSurfaceVisible } = await import('@/sync/domains/session/sessionSurfaceVisibility');
            expect(isSessionSurfaceVisible(id, h.homeB.id)).toBe(false);
            const { registerSessionRealtimeScmConsumerScope } = await import('@/sync/runtime/sessionRealtimeScmConsumers');
            const { resolveWorkspaceTargetForSession } = await import('@/sync/domains/session/resolveWorkspaceTargetForSession');
            const { scmDiffCache } = await import('@/scm/diffCache/scmDiffCacheSingleton');
            const releaseScm = registerSessionRealtimeScmConsumerScope({ serverId: h.homeB.id, sessionId: 'scm-surface',
                canonicalProjectKey: 'machine-b:/repo', machineScopeId: 'machine-b', repoRoot: '/repo' });
            const { resolveSessionLiveConsumption, resolveSessionScmMutationSignal } = await import('@/sync/runtime/sessionLiveConsumption');
            expect(resolveSessionLiveConsumption(id, h.homeB.id).isFullContentConsumer).toBe(false);
            expect(resolveSessionScmMutationSignal(id, h.homeB.id)).toBe(true);
            const target = resolveWorkspaceTargetForSession({ serverId: h.homeB.id, sessionId: id });
            if (!target) throw new Error('Expected the admitted secondary workspace target');
            const diffKey = { sessionId: target.workspaceCacheKey, snapshotSignature: 'before-edit', diffArea: 'pending' as const, path: '/repo/file.ts' };
            scmDiffCache.set(diffKey, 'old diff');
            try {
                const editRecord = { role: 'agent', content: { type: 'output', data: {
                    type: 'assistant', uuid: 'edit-record', message: { role: 'assistant', content: [{
                        type: 'tool_use', id: 'edit-tool', name: 'Edit', input: { file_path: '/repo/file.ts', old_string: 'a', new_string: 'b' },
                    }] },
                } } };
                h.socket().trigger('update', UpdateContainerSchema.parse({ id: 'secondary-scm-revision', seq: 3, createdAt: 6,
                    body: { t: 'message-updated', sid: id, delivery: 'full', message: { id: 'scm-edit', seq: 1, localId: null,
                        messageRole: 'agent', createdAt: 5, updatedAt: 6, content: { t: 'plain', v: editRecord },
                    } },
                }));
                await vi.waitFor(() => expect(scmDiffCache.get(diffKey)).toBeNull());
                expect(h.storage.getState().sessionMessages[id]).toBe(foreignMessages);
            } finally { releaseScm(); scmDiffCache.invalidateSession(target.workspaceCacheKey); }
        } finally { release(); }
    });

    it('retires the previous Home transcript and watermark when an ACK opens the same id in another Home', async () => {
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const { captureServerRequestAuthorityForServerAccountScope } = await import('./serverScopedRpc/createServerRequestWithServerScope');
        const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
        const id = 'same-id-home-switch';
        await h.select([h.homeA.id, h.homeB.id, h.homeC.id]);
        h.setSessions(h.homeC, [h.session({ id, seq: 20, metadataVersion: 20,
            metadata: { path: '/old-home', host: 'old-host' } })]);
        h.setSessions(h.homeB, [h.session({ id, seq: 5, metadataVersion: 5,
            metadata: { path: '/new-home', host: 'new-host' } })]);
        const record = (home: string, seq: number) => ({ id: `${home}-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
            content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: `${home} text ${seq}` } } } });
        h.setResponder(async input => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/pending')) return Response.json({ pending: [], pendingVersion: 0 });
            if (!url.pathname.endsWith('/messages')) return null;
            const records = url.origin === h.homeC.serverUrl ? [record('old Home', 10), record('old Home', 20)] : [record('new Home', 5)];
            const messages = url.searchParams.has('afterSeq') ? records.filter(row => row.seq > Number(url.searchParams.get('afterSeq')))
                : url.searchParams.has('beforeSeq') ? records.filter(row => row.seq < Number(url.searchParams.get('beforeSeq'))) : records.slice(-1);
            const hasMore = !url.searchParams.has('afterSeq') && messages[0]?.seq === 20;
            return Response.json({ messages, hasMore, nextBeforeSeq: hasMore ? 20 : null });
        });
        await h.start(); await h.ready(); await h.ready(h.homeC);
        const texts = () => Object.values(h.storage.getState().sessionMessages[id]?.messagesMap ?? {})
            .flatMap(message => message.kind === 'user-text' ? [message.text] : []);
        const releaseOld = registerSessionRealtimeTranscriptConsumer(id, h.homeC.id);
        try {
            await vi.waitFor(() => expect(h.storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeC.id);
            expect(texts()).toContain('old Home text 20');
            expect(await getSyncSingleton().loadOlderMessagesFromCursor(id, 20)).toMatchObject({ loaded: 1 });
            expect(texts()).toContain('old Home text 10');
            const authority = await captureServerRequestAuthorityForServerAccountScope({
                serverId: h.homeC.id,
                activeRequest: async () => { throw new Error('Secondary Home read must not use the active transport'); },
            });
            try {
                await getSyncSingleton().ensureSessionVisibleForMessageRoute(id, { serverId: h.homeC.id, forceRefresh: true, authority });
            } finally { await authority.release(); }
            expect(texts()).toContain('old Home text 10');
        } finally { releaseOld(); }
        const { buildSessionMessageObservationFactsV1 } = await import('@happier-dev/protocol');
        h.socket(h.homeC).trigger('update', { id: 'old-home-hidden-revision', seq: 21, createdAt: 21,
            body: { t: 'message-updated', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1({
                ...record('old Home', 20), updatedAt: 21,
            }) } });
        await Promise.resolve(); await Promise.resolve();
        const releaseNew = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        try {
            await vi.waitFor(() => expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeB.id));
            await vi.waitFor(() => expect(texts()).toEqual(['new Home text 5']));
            expect(h.storage.getState().sessions[id]?.seq).toBe(5);
            expect(h.storage.getState().sessions[id]?.metadataVersion).toBe(5);
            expect(readSessionOwnerMetadataView(h.storage.getState().sessions[id]!)).toMatchObject({ path: '/new-home', host: 'new-host' });
            const reads = h.requests(`/v1/sessions/${id}/messages`).filter(request => request.url.origin === h.homeB.serverUrl);
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.some(request => Number(request.url.searchParams.get('afterSeq')) > 5
                || Number(request.url.searchParams.get('beforeSeq')) > 6)).toBe(false);
        } finally { releaseNew(); getSyncSingleton().retireLocalSession(id, h.homeB.id); }
    });

    it('opens encrypted secondary Home transcript windows and older pages with the exact Home cipher', async () => {
        const { fetchSessionByIdWithServerScope } = await import('./serverScopedRpc/fetchSessionByIdWithServerScope');
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const id = 'secondary-encrypted-transcript';
        const secret = new Uint8Array(32).fill(71);
        const encryption = await Encryption.create(secret);
        const key = new Uint8Array(32).fill(72);
        await encryption.initializeSessions(new Map([[id, key]]));
        const cipher = encryption.getSessionEncryption(id)!;
        await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, {
            credentials: { token: h.homeB.token, secret: encodeBase64(secret, 'base64url') }, encryptionMode: 'e2ee',
        });
        const plain = h.session({ id, seq: 20 });
        if (plain.ownerMetadata?.t !== 'plain') throw new Error('Expected owner metadata fixture');
        const row = { ...plain, encryptionMode: 'e2ee' as const,
            metadata: await cipher.encryptRaw(JSON.parse(plain.metadata)),
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                ownerMetadata: plain.ownerMetadata.v, randomBytes: length => new Uint8Array(length).fill(73) }),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
        };
        const message = async (seq: number) => ({ id: `encrypted-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
            content: { t: 'encrypted' as const, c: await cipher.encryptRaw({ role: 'user', content: { type: 'text', text: `secondary text ${seq}` } }) } });
        const older = await message(10);
        let targetRow = await message(20);
        let current = targetRow;
        let heldRead: { started: ReturnType<typeof createDeferred<void>>; gate: ReturnType<typeof createDeferred<void>> } | null = null;
        h.setSessions(h.homeB, [row]);
        h.setResponder(async input => {
            const url = new URL(String(input));
            if (url.origin !== h.homeB.serverUrl) return null;
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'e2ee', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'available' } });
            if (url.pathname.endsWith('/messages')) {
                const hold = heldRead;
                heldRead = null;
                if (hold) { hold.started.resolve(); await hold.gate.promise; }
                const before = Number(url.searchParams.get('beforeSeq'));
                const after = Number(url.searchParams.get('afterSeq'));
                const records = [older, targetRow, ...(current.id === targetRow.id ? [] : [current])];
                const latest = url.searchParams.has('beforeSeq') ? records.filter(item => item.seq < before).at(-1) : current;
                const messages = url.searchParams.has('afterSeq') ? records.filter(item => item.seq > after) : latest ? [latest] : [];
                const hasMore = !url.searchParams.has('afterSeq') && (messages[0]?.seq ?? 0) > older.seq;
                return Response.json({ messages, hasMore, nextBeforeSeq: hasMore ? messages[0]?.seq : null, nextAfterSeq: null });
            }
            if (url.pathname === `/v2/sessions/${id}`) return Response.json({ session: row });
            if (url.pathname.endsWith('/pending')) return Response.json({ pending: [], pendingVersion: 0 });
            return null;
        });
        await h.start(); await h.refresh();
        expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]?.listObservation).toMatchObject({ phase: 'ready' });
        expect((await fetchSessionByIdWithServerScope({
            sessionId: id, serverId: h.homeB.id, contentDemand: 'session', activeCredentials: { token: h.homeA.token },
            activeRequest: async () => { throw new Error('Secondary transcript hydration must not use the active Home transport'); },
            activeEncryption: null, sessionDataKeys: new Map(), sessionDataKeyEnvelopes: new Map(), includeTurnsProjection: false,
            getExistingSession: sid => h.storage.getState().sessions[sid],
            applySessions: sessions => h.storage.getState().applySessions(sessions), log: { log() {} },
        })).ok).toBe(true);
        const sync = getSyncSingleton();
        expect(await sync.loadTargetWindowMessages(id, { kind: 'seq', seq: 20 })).toMatchObject({ status: 'loaded', targetPresent: true });
        const texts = () => Object.values(h.storage.getState().sessionMessages[id]?.messagesMap ?? {})
            .flatMap(item => item.kind === 'user-text' ? [item.text] : []);
        expect(texts()).toContain('secondary text 20');
        expect(await sync.loadOlderMessagesFromCursor(id, 20)).toMatchObject({ loaded: 1 });
        expect(texts()).toContain('secondary text 10');
        expect(h.httpRequests.filter(request => request.url.pathname.endsWith('/messages')).every(request => request.url.origin === h.homeB.serverUrl)).toBe(true);
        const { registerSessionRealtimeTranscriptConsumer } = await import('@/sync/runtime/sessionRealtimeTranscriptConsumers');
        const { buildSessionMessageObservationFactsV1 } = await import('@happier-dev/protocol');
        const release = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        try {
            current = { ...current, updatedAt: 21, content: { t: 'encrypted', c: await cipher.encryptRaw({ role: 'user', content: { type: 'text', text: 'secondary revised text 20' } }) } };
            targetRow = current;
            h.socket().trigger('update', { id: 'secondary-encrypted-revision', seq: 2, createdAt: 21,
                body: { t: 'message-updated', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1(current) } });
            await vi.waitFor(() => expect(texts()).toContain('secondary revised text 20'));
            await vi.waitFor(() => expect(h.storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
            current = await message(30);
            h.socket().trigger('update', { id: 'secondary-encrypted-append', seq: 3, createdAt: 30,
                body: { t: 'new-message', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1(current) } });
            await vi.waitFor(() => expect(texts()).toContain('secondary text 30'));
        } finally { release(); }
        // A hidden edit behind the materialized tail must survive the secondary
        // Home's row-only hint path, then repair when its real demand resumes.
        const { readStaleTranscriptMessageIds } = await import('@/sync/domains/session/realtime/deferredTranscriptState');
        const staleIds = () => readStaleTranscriptMessageIds((sync as unknown as {
            deferredTranscriptState: import('@/sync/domains/session/realtime/deferredTranscriptState').DeferredTranscriptState;
        }).deferredTranscriptState, id);
        targetRow = { ...targetRow, updatedAt: 41, content: { t: 'encrypted', c: await cipher.encryptRaw({
            role: 'user', content: { type: 'text', text: 'secondary edited while hidden' },
        }) } };
        const beforeHiddenEdit = h.httpRequests.filter(request => request.url.pathname.endsWith('/messages')).length;
        h.socket().trigger('update', { id: 'secondary-hidden-revision', seq: 4, createdAt: 41,
            body: { t: 'message-updated', sid: id, delivery: 'hint', message: buildSessionMessageObservationFactsV1(targetRow) } });
        await vi.waitFor(() => expect(staleIds()).toContain(targetRow.id));
        expect(texts()).not.toContain('secondary edited while hidden');
        expect(h.httpRequests.filter(request => request.url.pathname.endsWith('/messages'))).toHaveLength(beforeHiddenEdit);
        const reopen = registerSessionRealtimeTranscriptConsumer(id, h.homeB.id);
        try {
            await vi.waitFor(() => expect(texts()).toContain('secondary edited while hidden'));
            expect(texts()).toContain('secondary text 10');
            expect(texts()).toContain('secondary text 30');
        } finally { reopen(); }
        const hold = { started: createDeferred<void>(), gate: createDeferred<void>() };
        heldRead = hold;
        const pending = sync.loadTargetWindowMessages(id, { kind: 'seq', seq: 20 });
        try {
            await hold.started.promise;
            h.storage.getState().applySessions([createSessionFixture({ id, serverId: h.homeA.id })]);
            expect(h.storage.getState().sessions[id]?.serverId).toBe(h.homeA.id);
            const foreignTranscript = h.storage.getState().sessionMessages[id];
            hold.gate.resolve();
            expect((await pending).status).not.toBe('loaded');
            expect(h.storage.getState().sessionMessages[id]).toBe(foreignTranscript);
        } finally { hold.gate.resolve(); await pending; }
    });





    it.each(['existing cipher', 'first cipher'] as const)(
        'does not let a retained credential replace the current scoped Account owner (%s)', async initialMaterial => {
            const original = initialMaterial === 'existing cipher'
                ? { token: h.homeB.token, secret: encodeBase64(new Uint8Array(32).fill(41), 'base64url') }
                : { token: h.homeB.token };
            await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, {
                credentials: original, encryptionMode: 'e2ee',
            });
            h.setResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
                ? Response.json({ mode: 'e2ee', version: 1, signingKeyFingerprint: null,
                    contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } })
                : null);
            await h.start(); await h.ready();
            // Hold the existing reconciliation timer at the OS clock boundary.
            // The still-managed Home can receive page demand during rotation.
            vi.useFakeTimers();
            try {
                const replacement = { token: h.homeB.token,
                    secret: encodeBase64(new Uint8Array(32).fill(42), 'base64url') };
                expect(await h.TokenStorage.setCredentialsForServerUrl(h.homeB.serverUrl,
                    { serverId: h.homeB.id }, replacement)).toBe(true);
                const current = await resolveScopedAccountEncryption({ serverId: h.homeB.id,
                    serverUrl: h.homeB.serverUrl, credentials: replacement });
                if (!current) throw new Error('Expected replacement Account material');
                const captured = current.getCurrentEncryptionGenerationScope();
                expect(current.isCurrentEncryptionGenerationScope(captured)).toBe(true);

                // The old entry may fail closed, but must never register its old
                // material again and retire the newly admitted Account owner.
                await Promise.allSettled([h.fetchConcurrentSessionListQueryPage(h.homeB.id, {
                    source: { kind: 'ordinary', path: '/v2/sessions', allowV1Fallback: false },
                    membership: 'rowOnly', signal: new AbortController().signal,
                })]);

                expect(current.isCurrentEncryptionGenerationScope(captured)).toBe(true);
            } finally { vi.useRealTimers(); }
        },
    );

    it('catches demanded Run activity up through the actual concurrent Home reconnect', async () => {
        const { subscribeExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
        const activeActivity = vi.fn();
        const concurrentActivity = vi.fn();
        const releaseActive = subscribeExecutionRunActivity({ serverId: h.homeA.id, sessionId: 'roster-session' }, activeActivity);
        const releaseConcurrent = subscribeExecutionRunActivity({ serverId: h.homeB.id, sessionId: 'roster-session' }, concurrentActivity);
        try {
            await h.start(); await h.ready();
            expect(concurrentActivity).toHaveBeenCalledWith({ runId: null });
            concurrentActivity.mockClear();
            h.socket().trigger('disconnect', 'transport close');
            h.socket().trigger('connect');
            expect(concurrentActivity).toHaveBeenCalledTimes(1);
            expect(concurrentActivity).toHaveBeenCalledWith({ runId: null });
            expect(activeActivity).not.toHaveBeenCalled();
        } finally { releaseActive(); releaseConcurrent(); }
    });

    it('keeps shared encrypted content cold while retaining Account-owned names and demanded per-Home metadata', async () => {
        // Observe the real owner so accidental content demand is visible at
        // every batch size, including batches below the Worker threshold.
        const decryptDataKeys = vi.spyOn(Encryption.prototype, 'decryptEncryptionKeys');
        const secret = new Uint8Array(32).fill(7);
        const encryption = await Encryption.create(secret);
        await h.network.addHome(h.homeB.serverUrl, h.homeB.accountId, {
            credentials: { token: h.homeB.token, secret: encodeBase64(secret, 'base64url') }, encryptionMode: 'e2ee',
        });
        const encryptedRows = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
            const id = 'encrypted-session-' + index;
            const key = new Uint8Array(32).fill(index + 1);
            const row = h.session({ id, active: true, activeAt: 2, metadata: { path: '/repo', host: 'test', name: 'Encrypted ' + index } });
            if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected a Plain fixture to seal');
            await encryption.initializeSessions(new Map([[id, key]]));
            const cipher = encryption.getSessionEncryption(id);
            if (!cipher) throw new Error('Expected the Session fixture cipher');
            return { ...row, encryptionMode: 'e2ee' as const,
                metadata: await cipher.encryptRaw(JSON.parse(row.metadata)),
                ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
                    ownerMetadata: row.ownerMetadata.v, randomBytes: length => new Uint8Array(length).fill(index + 3) }),
                dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
            };
        }));
        h.setSessions(h.homeB, encryptedRows);
        h.setResponder(async input => {
            const url = new URL(String(input));
            if (url.origin !== h.homeB.serverUrl) return null;
            const path = url.pathname;
            if (path === '/v2/sessions/read-batch') return null;
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'e2ee', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'available' } });
            if (path === '/v2/sessions/active') return Response.json({ sessions: encryptedRows, nextCursor: null, hasNext: false });
            if (path.startsWith('/v2/sessions/')) {
                const row = encryptedRows.find(row => row.id === decodeURIComponent(path.slice('/v2/sessions/'.length)));
                return row ? Response.json({ session: row })
                    : Response.json({ error: 'Session not found' }, { status: 404 });
            }
            return null;
        });
        try {
            await h.start(); await h.ready();
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(0);
            expect(Object.keys(rows() ?? {})).toEqual(encryptedRows.map(row => row.id));
            for (const row of encryptedRows) {
                // The canonical locked-owner projection admits the Account-encrypted
                // name, but does not open Session-encrypted workspace content.
                expect(rows()?.[row.id]?.metadata?.name).toBe('Encrypted ' + encryptedRows.indexOf(row));
                expect(rows()?.[row.id]?.metadata?.path).toBe('');
                expect(h.storage.getState().sessionListRowsByServerId[h.homeA.id]?.[row.id]).toBeUndefined();
            }
            expect(h.socket().serverUrl).toBe(h.homeB.serverUrl);
            const { fetchSessionByIdWithServerScope } = await import('./serverScopedRpc/fetchSessionByIdWithServerScope');
            const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
            const sessionDataKeys = new Map<string, Uint8Array>();
            const sessionDataKeyEnvelopes = new Map<string, string>();
            const readDemandedSession = (sessionId: string) => fetchSessionByIdWithServerScope({
                sessionId, serverId: h.homeB.id, contentDemand: 'session',
                activeCredentials: { token: h.homeA.token },
                activeRequest: h.network.request,
                sessionDataKeys, sessionDataKeyEnvelopes, includeTurnsProjection: false,
                getCurrentSessionListRenderable: id => rows()?.[id],
                applySessions: sessions => h.storage.getState().applyServerScopedSessionListRows(
                    h.homeB.id, sessions.map(session => buildSessionListRenderableFromSession(session, rows()?.[session.id])),
                    { source: 'rowOnly', mode: 'append' },
                ),
                log: { log() {} },
            });
            for (const row of encryptedRows) expect((await readDemandedSession(row.id)).ok).toBe(true);
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(encryptedRows.length);
            expect(rows()?.['encrypted-session-0']?.metadata?.name).toBe('Encrypted 0');
            expect(rows()?.['encrypted-session-0']?.metadata?.path).toBe('/repo');
            decryptDataKeys.mockClear();
            for (const row of encryptedRows) expect((await readDemandedSession(row.id)).ok).toBe(true);
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(0);
            const demandedRows = rows();
            await h.refresh();
            for (const [index, row] of encryptedRows.entries()) {
                expect(rows()?.[row.id]?.metadata).toBe(demandedRows?.[row.id]?.metadata);
                expect(rows()?.[row.id]?.metadata?.name).toBe('Encrypted ' + index);
                expect(rows()?.[row.id]?.encryptedContentAvailability).toBe(demandedRows?.[row.id]?.encryptedContentAvailability);
            }
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(0);
            // The first lean refresh binds owner provenance to the concurrent
            // runtime's retained credentials; identical later refreshes reuse it.
            const initialRows = rows();
            await h.refresh();
            expect(rows()).toBe(initialRows);
            for (const row of encryptedRows) expect(rows()?.[row.id]).toBe(initialRows?.[row.id]);
            expect(rows()?.['encrypted-session-4']?.metadata?.name).toBe('Encrypted 4');
            // The harness's batch boundary splits each read-batch POST into its per-Session
            // component reads before this recorder, so the demanded reads are visible here.
            expect(h.requests('/v2/sessions/encrypted-session-0').map(request => request.url.origin))
                .toEqual([h.homeB.serverUrl, h.homeB.serverUrl]);
            expect(h.storage.getState().sessionListRowsByServerId[h.homeA.id]?.['encrypted-session-0']).toBeUndefined();
            expect(decryptDataKeys.mock.calls.flatMap(([values]) => values).length).toBe(0);
        } finally {
            decryptDataKeys.mockRestore();
        }
    });

    it('replaces stale machine entries when an authoritative refresh omits a removed machine', async () => {
        h.setMachines(h.homeB, [h.machine(h.homeB), h.machine(h.homeB, 'removed-machine')]);
        await h.start(); await h.ready();
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b', 'removed-machine']);
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), seq: 2 }]);
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b']);
        expect(machines()?.[0]?.seq).toBe(2);
    });

    it('invalidates only the non-active Home machine route when daemon state advances', async () => {
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), daemonStateVersion: 1 }]);
        await h.start(); await h.ready();
        for (const key of [route(), route(h.homeB.id, 'other-machine'), route(h.homeC.id)]) {
            routes.recordCachedMachineRpcDirectRouteViable(key);
        }
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(routes.readCachedMachineRpcDirectRoute(route())).toMatchObject({ status: 'viable' });
        h.setMachines(h.homeB, [{ ...h.machine(h.homeB), daemonStateVersion: 2 }]);
        await h.refreshConcurrentMachineList(h.homeB.id);
        expect(machines()?.[0]?.daemonStateVersion).toBe(2);
        expect(routes.readCachedMachineRpcDirectRoute(route())).toEqual({ status: 'unknown' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeB.id, 'other-machine'))).toMatchObject({ status: 'viable' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeC.id))).toMatchObject({ status: 'viable' });
    });

    it('keeps the active machine writer authoritative without withdrawing another Home or Machine route', async () => {
        await h.start(); await h.ready();
        const initial = h.storage.getState();
        h.storage.setState({ profile: { ...initial.profile, id: h.homeA.accountId },
            profileScope: { serverId: h.homeA.id, accountId: h.homeA.accountId } });
        try {
            const machine = createMachineFixture({ id: 'active-machine', daemonStateVersion: 1 });
            const source = { sourceServerId: h.homeA.id, sourceAccountId: h.homeA.accountId };
            h.storage.getState().applyMachines([machine], true, source);
            const active = route(h.homeA.id, machine.id);
            const otherMachine = route(h.homeA.id, 'other-machine');
            const otherHome = route(h.homeB.id, machine.id);
            for (const key of [active, otherMachine, otherHome]) routes.recordCachedMachineRpcDirectRouteViable(key);
            h.storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2 }], true, source);
            expect(h.storage.getState().machines[machine.id]?.daemonStateVersion).toBe(2);
            expect(routes.readCachedMachineRpcDirectRoute(active)).toEqual({ status: 'unknown' });
            expect(routes.readCachedMachineRpcDirectRoute(otherMachine)).toMatchObject({ status: 'viable' });
            expect(routes.readCachedMachineRpcDirectRoute(otherHome)).toMatchObject({ status: 'viable' });
        } finally { h.storage.setState({ profile: initial.profile, profileScope: initial.profileScope }); }
    });

    it('keeps canonical rows stable without copying them into the concurrent Home cache', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b', metadata: { path: '/repo', host: 'test', name: 'Secondary Session' } })]);
        await h.start(); await h.ready();
        const initialRows = h.storage.getState().sessionListRowsByServerId;
        const projection = h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id];
        expect(rows()?.['session-b']?.metadata?.name).toBe('Secondary Session');
        expect(projection).not.toHaveProperty('sessions');
        expect(projection).not.toHaveProperty('sessionRows');
        await h.refresh();
        expect(h.storage.getState().sessionListRowsByServerId).toBe(initialRows);
        expect(Array.isArray(h.storage.getState().sessionListIndexByServerId[h.homeB.id])).toBe(true);
        expect(h.storage.getState().ordinarySessionListMembershipByServerId[h.homeB.id]).toEqual(['session-b']);
    });

    it('keeps the list index stable when only non-structural Session fields change', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b', seq: 1, updatedAt: 2000 })]);
        await h.start(); await h.ready();
        const beforeIndex = h.storage.getState().sessionListIndexByServerId[h.homeB.id];
        const beforeRows = rows();
        h.setSessions(h.homeB, [h.session({ id: 'session-b', seq: 2, updatedAt: 3000 })]);
        await h.refresh();
        expect(h.storage.getState().sessionListIndexByServerId[h.homeB.id]).toBe(beforeIndex);
        expect(rows()).not.toBe(beforeRows);
        expect(rows()?.['session-b']?.updatedAt).toBe(3000);
    });

    it('invalidates cached transfer routes when a concurrent Home is removed from the desired set', async () => {
        await h.start(); await h.ready();
        routes.recordCachedMachineRpcDirectRouteViable(route());
        routes.recordCachedMachineRpcDirectRouteViable(route(h.homeC.id));
        await h.select([h.homeA.id]);
        await vi.waitFor(() => expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false));
        expect(routes.readCachedMachineRpcDirectRoute(route())).toEqual({ status: 'unknown' });
        expect(routes.readCachedMachineRpcDirectRoute(route(h.homeC.id))).toMatchObject({ status: 'viable' });
    });

    it('isolates concurrent Session and machine refreshes by Home', async () => {
        h.setSessions(h.homeB, [h.session({ id: 'session-b' })]);
        h.setSessions(h.homeC, [h.session({ id: 'session-c' })]);
        h.setMachines(h.homeB, [h.machine(h.homeB)]);
        h.setMachines(h.homeC, [h.machine(h.homeC, 'machine-c')]);
        await h.select([h.homeA.id, h.homeB.id, h.homeC.id]);
        await h.start(); await h.ready(); await h.ready(h.homeC);
        expect(Object.keys(rows() ?? {})).toEqual(['session-b']);
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[h.homeC.id] ?? {})).toEqual(['session-c']);
        expect(machines()?.map(machine => machine.id)).toEqual(['machine-b']);
        expect(h.storage.getState().machineListByServerId[h.homeC.id]?.map(machine => machine.id)).toEqual(['machine-c']);
    });

    it('scopes same-URL alternate persisted profiles by exact Home identity and Account', async () => {
        const identityB = 'srv_same_url_home_b';
        const identityC = 'srv_same_url_home_c';
        const [aProfile, bProfile, cProfile] = [h.homeA, h.homeB, h.homeC].map(home => h.profiles.getServerProfileById(home.id));
        if (!aProfile || !bProfile || !cProfile) throw new Error('Expected the saved Home profiles');
        const b = { ...bProfile, serverIdentityId: identityB, legacyServerIds: [h.homeB.id], canonicalServerUrl: h.homeB.serverUrl };
        const c = { ...cProfile, serverIdentityId: identityC, legacyServerIds: [h.homeC.id],
            serverUrl: h.homeB.serverUrl, canonicalServerUrl: h.homeB.serverUrl };
        const browserStorage = typeof window !== 'undefined' && typeof document !== 'undefined'
            ? window.localStorage : undefined;
        await seedPersistedHomeProfilesForTests({ profiles: [aProfile, b, c], activeServerId: h.homeA.id, browserStorage });
        expect(h.profiles.resolveServerProfileScopeIdForIdentifier(identityB)).toBe(identityB);
        expect(h.profiles.resolveServerProfileScopeIdForIdentifier(identityC)).toBe(identityC);
        expect(await h.TokenStorage.setCredentialsForServerUrl(b.serverUrl, { serverId: identityB }, { token: h.homeB.token })).toBe(true);
        expect(await h.TokenStorage.setCredentialsForServerUrl(c.serverUrl, { serverId: identityC }, { token: h.homeC.token })).toBe(true);
        h.setResponder(async (input, init) => {
            const url = new URL(String(input));
            const isC = new Headers(init?.headers).get('authorization') === 'Bearer ' + h.homeC.token;
            if (url.pathname === '/v2/sessions') return Response.json({ sessions: [h.session({ id: isC ? 'session-c' : 'session-b' })], nextCursor: null, hasNext: false });
            if (url.pathname === '/v1/machines') return Response.json([h.machine(isC ? h.homeC : h.homeB, isC ? 'machine-c' : 'machine-b')]);
            return null;
        });
        await h.select([h.homeA.id, identityB, identityC]);
        h.startConcurrentSessionCacheSync();
        await h.ready({ ...h.homeB, id: identityB }); await h.ready({ ...h.homeC, id: identityC });
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[identityB] ?? {})).toEqual(['session-b']);
        expect(Object.keys(h.storage.getState().sessionListRowsByServerId[identityC] ?? {})).toEqual(['session-c']);
        expect(h.storage.getState().sessionListRowsByServerId[b.id]).toBeUndefined();
        expect(h.network.credentialRequests).toEqual(expect.arrayContaining([
            { serverUrl: b.serverUrl, serverId: identityB }, { serverUrl: c.serverUrl, serverId: identityC },
        ]));
    });

    it('clears stale non-active caches when a Home is removed from concurrent selection', async () => {
        await h.select([h.homeA.id, h.homeB.id, h.homeC.id]);
        await h.start(); await h.ready(); await h.ready(h.homeC);
        await h.select([h.homeA.id, h.homeB.id]);
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeC.id]).toBeUndefined());
        expect(h.storage.getState().machineListByServerId[h.homeC.id]).toBeUndefined();
        expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(true);
    });

    it('reconciles a renamed secondary profile without a selection or focus change', async () => {
        await h.start(); await h.ready();
        await h.profiles.adoptHomeProfile({ descriptor: { serverUrl: h.homeB.serverUrl, displayName: 'Renamed B' }, source: 'manual' });
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]?.serverName).toBe('Renamed B'));
        expect(h.profiles.getActiveServerId()).toBe(h.homeA.id);
    });

    it('stops a secondary transport and clears caches when its profile disappears', async () => {
        await h.start(); await h.ready();
        const socket = h.socket();
        await h.profiles.removeServerProfile(h.homeB.id);
        await vi.waitFor(() => expect(h.storage.getState().concurrentSessionListCacheByServerId[h.homeB.id]).toBeUndefined());
        expect(h.storage.getState().machineListByServerId[h.homeB.id]).toBeUndefined();
        expect(socket.socket.connected).toBe(false);
    });

    it('does not resurrect a stopped cache after its deferred OS credential read settles', async () => {
        const gate = h.holdCredentialRead();
        h.startConcurrentSessionCacheSync();
        await vi.waitFor(() => expect(gate.started).toBe(true));
        h.stopConcurrentSessionCacheSync();
        gate.release();
        expect(Boolean(await h.TokenStorage.getCredentialsForServerUrl(h.homeB.serverUrl, { serverId: h.homeB.id }))).toBe(true);
        expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false);
        expect(h.network.socketBoundaries.filter(socket => socket.serverUrl === h.homeB.serverUrl)).toEqual([]);
        expect(rows()).toBeUndefined();
    });

    it('does not publish a stale HTTP snapshot after its Home entry has been retired', async () => {
        let signal: AbortSignal | null | undefined;
        let finish!: () => void;
        h.setResponder(async (input, init) => {
            if (new URL(String(input)).pathname !== '/v2/sessions') return null;
            signal = init?.signal;
            await new Promise<void>(resolve => { finish = resolve; });
            return Response.json({ sessions: [h.session({ id: 'stale-session' })], nextCursor: null, hasNext: false });
        });
        await h.start();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        await h.select([h.homeA.id]);
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        finish();
        await vi.waitFor(() => expect(h.isConcurrentOrdinarySessionListHome(h.homeB.id)).toBe(false));
        expect(rows()).toBeUndefined();
        expect(machines()).toBeUndefined();
    });
});
