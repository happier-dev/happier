import { describe, expect, it, vi } from 'vitest';
import {
    canonicalSessionDraftAddressV2,
    SessionDraftDocumentV1Schema,
    type SessionDraftAddressV2,
    type SessionDraftDocumentV2,
    type SessionDraftStoredContentEnvelopeV2,
} from '@happier-dev/protocol';

import {
    createSessionDraftRepository,
    type SessionDraftRepositoryCipher,
    type SessionDraftRepositoryTransport,
} from './sessionDraftRepository';
import { createDeferred, requireComposerDraftDocument } from '@/dev/testkit';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { SessionDraftEpochUnavailableError } from './sessionDraftEpochError';
import { readNewSessionAttachmentDrafts, writeNewSessionAttachmentDrafts, clearAllNewSessionAttachmentDrafts } from '@/components/sessions/new/attachments/newSessionAttachmentDraftStore';
import { resolveNewSessionDraftAttachmentFlowId } from '@/components/sessions/new/attachments/newSessionDraftAttachmentFlowId';
import { materializeSessionDraftSocketWake } from '@/sync/runtime/orchestration/sessionDraftSyncRuntime';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const runAddress = { kind: 'run', sessionId: 'session-a', runId: 'run-a' } as const;
const discussionAddress = { kind: 'discussion', discussionId: 'disc-a' } as const;
const newDiscussionAddress = { kind: 'newDiscussion', } as const;

function createMemoryStorage() {
    const values = new Map<string, string>();
    return {
        values,
        getString: (key: string) => values.get(key),
        set: (key: string, value: string) => values.set(key, value),
        delete: (key: string) => values.delete(key),
    };
}

function plainCipher(): SessionDraftRepositoryCipher {
    return {
        seal: vi.fn(async (address: SessionDraftAddressV2, document: SessionDraftDocumentV2) => ({
            t: 'plain' as const,
            v: { v: document.v === 2 ? 2 as const : 1 as const, address, document },
        }) as SessionDraftStoredContentEnvelopeV2),
        open: vi.fn(async (address: SessionDraftAddressV2, content: SessionDraftStoredContentEnvelopeV2) => {
            if (content.t !== 'plain') return null;
            if (canonicalSessionDraftAddressV2(content.v.address) !== canonicalSessionDraftAddressV2(address)) return null;
            return content.v.document;
        }),
    };
}

function createRemote(address: SessionDraftAddressV2) {
    let current: { revision: number; content: SessionDraftStoredContentEnvelopeV2 | null; createdAt: number; updatedAt: number } | null = null;
    const transport: SessionDraftRepositoryTransport = {
        read: vi.fn(async () => (current === null
            ? { status: 'absent' as const }
            : current.content === null
                ? { status: 'deleted' as const, record: { ...current, address } }
                : { status: 'present' as const, record: { ...current, address } })),
        list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
        mutate: vi.fn(async ({ expectedRevision, content }) => {
            const currentRevision = current?.revision ?? 'absent';
            if (currentRevision !== expectedRevision) {
                return {
                    status: 'conflict' as const,
                    current: current ? { address, ...current } : { status: 'absent' as const },
                };
            }
            const now = 100 + (current?.revision ?? 0);
            current = {
                revision: current ? current.revision + 1 : 0,
                content,
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
            };
            return { status: 'updated' as const, record: { address, ...current } };
        }),
    };
    return { transport, readCurrent: () => current, replaceCurrent: (next: NonNullable<typeof current>) => { current = next; } };
}

describe('session draft repository V2 addresses', () => {
    it.each(['plain', 'e2ee'] as const)('opens only changed records when refreshing a 95-draft collection in the same cipher lifetime (%s)', async (accountMode) => {
        const cipher = createSessionDraftCipher({
            accountMode, accountCryptoMaterial: accountMode === 'plain' ? null : { type: 'dataKey', machineKey: new Uint8Array(32).fill(42) },
            getSessionContext: () => null, randomBytes: length => new Uint8Array(length),
        });
        const author = createSessionDraftRepository({ storage: createMemoryStorage(), scope, cipher, syncEnabled: false });
        const records = await Promise.all(Array.from({ length: 95 }, async (_, index) => {
            const draftId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
            author.writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: { text: `Draft ${index}` } });
            const snapshot = author.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })!;
            return { address: snapshot.address, revision: 1, createdAt: index, updatedAt: index,
                content: await cipher.seal(snapshot.address, snapshot.document) };
        }));
        let opens = 0;
        const measuredCipher: SessionDraftRepositoryCipher = { ...cipher, open: async (...args) => { opens += 1; return cipher.open(...args); } };
        const transport: SessionDraftRepositoryTransport = {
            list: async () => ({ items: records, nextAfter: undefined }),
            read: async () => ({ status: 'absent' }), mutate: async () => { throw new Error('Unexpected mutation'); },
        };
        const repository = createSessionDraftRepository({ storage: createMemoryStorage(), scope, cipher: measuredCipher, transport, syncEnabled: true });
        const start = performance.now();
        await repository.ensureSessionDraftRepositoryHydrated(scope);
        const firstMs = performance.now() - start;
        const before = repository.listNewSessionDraftProjections(scope);
        const refreshStart = performance.now();
        for (let index = 0; index < 10; index += 1) await repository.ensureSessionDraftRepositoryHydrated(scope);
        const refreshMs = performance.now() - refreshStart;
        expect(repository.listNewSessionDraftProjections(scope)).toBe(before);
        console.info('[PERF-RENDER drafts]', JSON.stringify({ accountMode, drafts: records.length, refreshes: 10, opens, firstMs, refreshMs }));
        expect(opens).toBe(95);
        const record = records[0]!;
        const document = author.getSessionDraftSnapshot(scope, record.address)!.document;
        if (!('composer' in document)) throw new Error('Expected a New Session document');
        author.writeNewSessionDraft({ scope, draftId: record.address.kind === 'newSession' ? record.address.draftId : '',
            materializationIntent: 'userEdit', patch: { text: 'Remote edit' } });
        record.revision += 1;
        record.updatedAt += 1;
        record.content = await cipher.seal(record.address, author.getSessionDraftSnapshot(scope, record.address)!.document);
        await repository.ensureSessionDraftRepositoryHydrated(scope);
        const refreshed = repository.getSessionDraftSnapshot(scope, record.address);
        expect(refreshed && 'composer' in refreshed.document ? refreshed.document.composer.text.value : null).toBe('Remote edit');
        expect(opens).toBe(96);
        expect(repository.listNewSessionDraftProjections(scope)[1]).toBe(before[1]);
        // A replacement cipher must revalidate even an unchanged server revision.
        const replacement = createSessionDraftCipher({ accountMode: 'e2ee', accountCryptoMaterial: null,
            getSessionContext: () => null, randomBytes: length => new Uint8Array(length) });
        repository.configure({ scope, cipher: replacement, transport, syncEnabled: true });
        await expect(repository.ensureSessionDraftRepositoryHydrated(scope)).rejects.toThrow('Unable to open');
        expect(document.composer.text.value).toBe('Draft 0');
    });
    it.each(['present', 'deleted'] as const)('refreshes a newer socket invalidation after an older exact read settles (%s)', async (status) => {
        const address = { kind: 'newSession' as const, draftId: '00000000-0000-4000-8000-000000000991' };
        const remote = createRemote(address);
        const cipher = createSessionDraftCipher({
            accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => null, randomBytes: length => new Uint8Array(length),
        });
        const author = createSessionDraftRepository({ storage: createMemoryStorage(), scope, transport: remote.transport, cipher, syncEnabled: true });
        author.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'before remote change' } });
        expect(await author.flushSessionDraft({ scope, address })).toEqual({ status: 'clean' });
        const readStarted = createDeferred<void>();
        const readHeld = createDeferred<void>();
        const originalRead = remote.transport.read;
        let first = true;
        const observerTransport: SessionDraftRepositoryTransport = {
            ...remote.transport,
            read: async target => {
                const snapshot = await originalRead(target);
                if (first) { first = false; readStarted.resolve(); await readHeld.promise; }
                return snapshot;
            },
        };
        const observer = createSessionDraftRepository({ storage: createMemoryStorage(), scope, transport: observerTransport, cipher, syncEnabled: true });
        const admission = observer.materializeExact(scope, address);
        await readStarted.promise;
        if (status === 'present') {
            author.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'newer remote change' } });
            expect(await author.flushSessionDraft({ scope, address })).toEqual({ status: 'clean' });
        } else {
            expect(await author.deleteSessionDraft({ scope, address })).toBe(true);
        }
        const revision = remote.readCurrent()!.revision;
        const wake = materializeSessionDraftSocketWake({
            payload: { type: 'session-draft-v2-updated', v: 2, sessionDraftV2: true, address, revision, status },
            capturedScope: scope, readActiveScope: () => scope,
            materializeExact: observer.materializeExact.bind(observer),
        });
        // Equivalent duplicate delivery and foreground demand share the same fresh follow-up.
        const duplicateWake = materializeSessionDraftSocketWake({
            payload: { type: 'session-draft-v2-updated', v: 2, sessionDraftV2: true, address, revision, status },
            capturedScope: scope, readActiveScope: () => scope,
            materializeExact: observer.materializeExact.bind(observer),
        });
        const foreground = observer.materializeExact(scope, address);
        readHeld.resolve();
        expect(await wake).toBe(true);
        expect(await duplicateWake).toBe(true);
        await Promise.all([admission, foreground]);
        const afterWake = observer.getSessionDraftSnapshot(scope, address);
        if (status === 'present') {
            expect(requireComposerDraftDocument(afterWake?.document)?.composer.text.value).toBe('newer remote change');
        } else {
            expect(afterWake).toBeNull();
        }
        expect(originalRead).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['collection', 'socket wake'], ['scoped exact read', 'socket wake'],
        ['collection', 'local delete'], ['scoped exact read', 'local delete'],
    ] as const)('does not resurrect a tombstoned draft from a %s captured before its %s', async (path, deletion) => {
        const address = { kind: 'newSession' as const, draftId: '00000000-0000-4000-8000-000000000992' };
        const remote = createRemote(address);
        const cipher = plainCipher();
        const author = createSessionDraftRepository({ storage: createMemoryStorage(), scope, transport: remote.transport, cipher, syncEnabled: true });
        author.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'deleted remotely' } });
        await author.flushSessionDraft({ scope, address });
        const observer = createSessionDraftRepository({ storage: createMemoryStorage(), scope, transport: remote.transport, cipher, syncEnabled: true });
        await observer.materializeExact(scope, address);
        const listed = createDeferred<void>();
        const release = createDeferred<void>();
        const current = remote.readCurrent()!;
        if (!current.content) throw new Error('Expected present captured record');
        const capturedRecord = { ...current, content: current.content, address };
        if (path === 'collection') {
            vi.mocked(remote.transport.list).mockImplementationOnce(async () => {
                listed.resolve();
                await release.promise;
                return { items: [capturedRecord], nextAfter: undefined };
            });
        } else {
            vi.mocked(remote.transport.read).mockImplementationOnce(async () => {
                listed.resolve();
                await release.promise;
                return { status: 'present', record: capturedRecord };
            });
        }
        const staleRead = path === 'collection'
            ? observer.ensureSessionDraftRepositoryHydrated(scope)
            : observer.materializeExactWithScopedRuntime({ scope, address, runtime: { cipher, transport: remote.transport }, isCurrent: () => true });
        await listed.promise;
        if (deletion === 'local delete') {
            expect(await observer.deleteSessionDraft({ scope, address })).toBe(true);
        } else {
            expect(await author.deleteSessionDraft({ scope, address })).toBe(true);
            expect(await materializeSessionDraftSocketWake({
                payload: { type: 'session-draft-v2-updated', v: 2, sessionDraftV2: true, address,
                    revision: remote.readCurrent()!.revision, status: 'deleted' },
                capturedScope: scope, readActiveScope: () => scope,
                materializeExact: observer.materializeExact.bind(observer),
            })).toBe(true);
        }
        expect(observer.getSessionDraftSnapshot(scope, address)).toBeNull();
        if (path === 'scoped exact read') {
            // A configured active-Home switch does not retire the captured Home
            // authority of this independently current scoped operation.
            observer.configure({ scope: { serverId: 'other-server', accountId: 'other-account' },
                cipher, syncEnabled: true, transport: createRemote(address).transport });
        }
        release.resolve();
        await staleRead;
        expect(observer.getSessionDraftSnapshot(scope, address)).toBeNull();
        // A real later revision is still adoptable; the tombstone is an ordering
        // guard, not a permanent prohibition on re-creating this draft.
        const deletedRecord = remote.readCurrent()!;
        remote.replaceCurrent({ ...deletedRecord, revision: deletedRecord.revision + 1, content: capturedRecord.content });
        await observer.materializeExactWithScopedRuntime({ scope, address, runtime: { cipher, transport: remote.transport }, isCurrent: () => true });
        expect(requireComposerDraftDocument(observer.getSessionDraftSnapshot(scope, address)?.document)?.composer.text.value).toBe('deleted remotely');
    });

    it('shares an in-flight exact read between foreground surfaces and reads fresh again afterward', async () => {
        const address = { kind: 'newSession' as const, draftId: '00000000-0000-4000-8000-000000000904' };
        const readStarted = createDeferred<void>();
        const readHeld = createDeferred<void>();
        const remote = createRemote(address);
        vi.mocked(remote.transport.read).mockImplementation(async () => {
            readStarted.resolve();
            await readHeld.promise;
            return { status: 'absent' };
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, cipher: plainCipher(), syncEnabled: true, transport: remote.transport,
        });
        const first = repository.materializeExact(scope, address);
        await readStarted.promise;
        const second = repository.materializeExact(scope, address);
        readHeld.resolve();
        await Promise.all([first, second]);
        expect(remote.transport.read).toHaveBeenCalledTimes(1);
        await repository.materializeExact(scope, address);
        expect(remote.transport.read).toHaveBeenCalledTimes(2);
        vi.mocked(remote.transport.read).mockRejectedValueOnce(new Error('offline'));
        const failed = await Promise.allSettled([
            repository.materializeExact(scope, address), repository.materializeExact(scope, address),
        ]);
        expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected']);
        expect(remote.transport.read).toHaveBeenCalledTimes(3);
        await repository.materializeExact(scope, address);
        expect(remote.transport.read).toHaveBeenCalledTimes(4);
    });

    it('does not share foreground reads across a replaced Account runtime or let its late read publish', async () => {
        const address = { kind: 'newSession' as const, draftId: '00000000-0000-4000-8000-000000000905' };
        const scopeB = { serverId: 'server-a', accountId: 'account-b' };
        const remoteA = createRemote(address);
        const remoteB = createRemote(address);
        const cipher = plainCipher();
        const writer = createSessionDraftRepository({ storage: createMemoryStorage(), scope, cipher, syncEnabled: true, transport: remoteA.transport });
        writer.writeNewSessionDraft({ scope, draftId: address.draftId, patch: { text: 'Account A private text' }, materializationIntent: 'userEdit' });
        await writer.flushSessionDraft({ scope, address });
        const readStarted = createDeferred<void>();
        const readHeld = createDeferred<void>();
        const heldTransport: SessionDraftRepositoryTransport = {
            ...remoteA.transport,
            read: async target => {
                const result = await remoteA.transport.read(target);
                readStarted.resolve();
                await readHeld.promise;
                return result;
            },
        };
        const repository = createSessionDraftRepository({ storage: createMemoryStorage(), scope, cipher, syncEnabled: true, transport: heldTransport });
        const oldRead = repository.ensureSessionDraftAddressesHydrated(scope, [address]);
        await readStarted.promise;
        repository.configure({ scope: scopeB, cipher, syncEnabled: true, transport: remoteB.transport });
        await expect(repository.ensureSessionDraftAddressesHydrated(scopeB, [address])).resolves.toBe(true);
        await expect(repository.ensureSessionDraftAddressesHydrated(scope, [address])).resolves.toBe(false);
        readHeld.resolve();
        await expect(oldRead).resolves.toBe(false);
        expect(repository.getSessionDraftSnapshot(scope, address)).toBeNull();
        expect(repository.getSessionDraftSnapshot(scopeB, address)).toBeNull();
    });

    it.each(['local', 'scoped', 'synchronized'] as const)('reclaims only authoritatively removed New Session attachment sources (%s)', async (mode) => {
        clearAllNewSessionAttachmentDrafts();
        const address = { kind: 'newSession' as const, draftId: '00000000-0000-4000-8000-000000000801' };
        const survivorId = '00000000-0000-4000-8000-000000000802';
        const flowId = resolveNewSessionDraftAttachmentFlowId(address.draftId);
        const survivorFlow = resolveNewSessionDraftAttachmentFlowId(survivorId);
        const bytes = new Uint8Array([1, 2, 3]);
        const files = [{ id: 'local-file', status: 'pending' as const, source: { kind: 'memory' as const, bytes, name: 'local.txt' } }];
        writeNewSessionAttachmentDrafts(flowId, files, scope);
        writeNewSessionAttachmentDrafts(survivorFlow, files, scope);
        const remote = createRemote(address);
        const cipher = plainCipher();
        let cleanupFinished = false;
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, cipher,
            syncEnabled: mode !== 'local', transport: mode === 'local' ? undefined : remote.transport,
            onDraftRemoved: async () => {
                // The installed cleanup is composed, rather than replaced; its
                // failure must still retain sources for the repository's retry.
                expect(readNewSessionAttachmentDrafts(flowId, scope)[0]?.source).toMatchObject({ bytes });
                cleanupFinished = true;
            },
        });
        repository.writeNewSessionDraft({ scope, draftId: address.draftId, patch: { text: 'delete me' }, materializationIntent: 'userEdit' });
        repository.writeNewSessionDraft({ scope, draftId: survivorId, patch: { text: 'keep me' }, materializationIntent: 'userEdit' });
        if (mode !== 'local') await repository.flushSessionDraft({ scope, address });
        if (mode === 'scoped') {
            await expect(repository.deleteSessionDraftWithScopedRuntime({ scope, address,
                runtime: { transport: remote.transport, cipher }, isCurrent: () => true,
            })).resolves.toBe(true);
        } else if (mode === 'synchronized') {
            // A tombstone from another client enters the same removal owner.
            const existing = remote.readCurrent()!;
            remote.replaceCurrent({ ...existing, revision: existing.revision + 1, content: null });
            await repository.materializeExact(scope, address);
        } else {
            await expect(repository.deleteSessionDraft({ scope, address })).resolves.toBe(true);
        }
        expect(cleanupFinished).toBe(true);
        expect(repository.getSessionDraftSnapshot(scope, address)).toBeNull();
        expect(readNewSessionAttachmentDrafts(flowId, scope)).toEqual([]);
        expect(readNewSessionAttachmentDrafts(survivorFlow, scope)[0]?.source).toMatchObject({ bytes });
        expect(repository.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: survivorId })).not.toBeNull();
        clearAllNewSessionAttachmentDrafts();
    });

    it('retains attachment bytes when draft removal is refused, fails remotely, or local cleanup fails', async () => {
        clearAllNewSessionAttachmentDrafts();
        const address = { kind: 'newSession' as const, draftId: '00000000-0000-4000-8000-000000000803' };
        const flowId = resolveNewSessionDraftAttachmentFlowId(address.draftId);
        const bytes = new Uint8Array([4, 5, 6]);
        writeNewSessionAttachmentDrafts(flowId, [{ id: 'retained', status: 'pending', source: { kind: 'memory', bytes, name: 'retained.txt' } }]);
        const remote = createRemote(address);
        const cipher = plainCipher();
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, cipher, syncEnabled: true, transport: remote.transport,
            onDraftRemoved: async () => { throw new Error('custody busy'); },
        });
        repository.writeNewSessionDraft({ scope, draftId: address.draftId, patch: { text: 'retain me' }, materializationIntent: 'userEdit' });
        await repository.flushSessionDraft({ scope, address });
        await expect(repository.deleteSessionDraftWithScopedRuntime({ scope, address,
            runtime: { cipher, transport: remote.transport }, isCurrent: () => false,
        })).resolves.toBe(false);
        expect(readNewSessionAttachmentDrafts(flowId)[0]?.source).toMatchObject({ bytes });
        vi.mocked(remote.transport.mutate).mockRejectedValueOnce(new Error('offline'));
        await expect(repository.deleteSessionDraft({ scope, address })).rejects.toThrow('offline');
        expect(readNewSessionAttachmentDrafts(flowId)[0]?.source).toMatchObject({ bytes });
        await expect(repository.deleteSessionDraft({ scope, address })).rejects.toThrow('custody busy');
        expect(readNewSessionAttachmentDrafts(flowId)[0]?.source).toMatchObject({ bytes });
        clearAllNewSessionAttachmentDrafts();
    });

    it('materializes an inactive exact Home through an operation-scoped runtime without reading the configured active Home', async () => {
        const address = { kind: 'session', sessionId: 'shared-session-id' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        const remoteA = createRemote(address);
        const remoteB = createRemote(address);
        const cipher = plainCipher();
        const writerB = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope: scopeB,
            transport: remoteB.transport,
            cipher,
            syncEnabled: true,
        });
        writerB.writeExistingSessionDraft({
            scope: scopeB,
            sessionId: address.sessionId,
            patch: { text: 'Home B draft' },
        });
        await writerB.flushSessionDraft({ scope: scopeB, address });

        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: remoteA.transport,
            cipher,
            syncEnabled: true,
        });
        await repository.materializeExactWithScopedRuntime({
            scope: scopeB,
            address,
            runtime: { transport: remoteB.transport, cipher },
            isCurrent: () => true,
        });

        expect(requireComposerDraftDocument(repository.getSessionDraftSnapshot(scopeB, address)?.document)?.composer.text.value)
            .toBe('Home B draft');
        expect(remoteB.transport.read).toHaveBeenCalledOnce();
        expect(remoteA.transport.read).not.toHaveBeenCalled();
    });

    it('hydrates an inactive Home remote-only draft collection without using the configured active Home runtime', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000901' } as const;
        const inactiveScope = { serverId: 'server-b', accountId: 'account-b' } as const;
        const activeRemote = createRemote(address);
        const inactiveRemote = createRemote(address);
        const cipher = plainCipher();
        const writer = createSessionDraftRepository({
            storage: createMemoryStorage(), scope: inactiveScope, transport: inactiveRemote.transport, cipher, syncEnabled: true,
        });
        writer.writeNewSessionDraft({
            scope: inactiveScope,
            draftId: address.draftId,
            patch: { text: 'waiting on inactive Home' },
            materializationIntent: 'userEdit',
        });
        await writer.flushSessionDraft({ scope: inactiveScope, address });
        const record = inactiveRemote.readCurrent();
        expect(record).not.toBeNull();
        vi.mocked(inactiveRemote.transport.list)
            .mockResolvedValueOnce({ items: [], nextAfter: 'second-page' })
            .mockResolvedValueOnce({ items: [{ address, ...record! }], nextAfter: undefined });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, transport: activeRemote.transport, cipher, syncEnabled: true,
        });

        await repository.ensureSessionDraftRepositoryHydratedWithScopedRuntime({
            scope: inactiveScope,
            runtime: { transport: inactiveRemote.transport, cipher },
            isCurrent: () => true,
        });

        expect(repository.listNewSessionDraftProjections(inactiveScope)).toMatchObject([{
            draftId: address.draftId,
            document: { composer: { text: { value: 'waiting on inactive Home' } } },
        }]);
        expect(activeRemote.transport.list).not.toHaveBeenCalled();
        expect(activeRemote.transport.read).not.toHaveBeenCalled();
        expect(inactiveRemote.transport.list).toHaveBeenNthCalledWith(2, { after: 'second-page', limit: 100 });
    });

    it('publishes nothing when an inactive Home scoped hydration retires during the list response', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000902' } as const;
        const inactiveScope = { serverId: 'server-b', accountId: 'account-b' } as const;
        const cipher = plainCipher();
        const response = createDeferred<Awaited<ReturnType<SessionDraftRepositoryTransport['list']>>>();
        const transport: SessionDraftRepositoryTransport = {
            list: vi.fn(async () => response.promise),
            read: vi.fn(async () => ({ status: 'absent' as const })),
            mutate: vi.fn(async () => { throw new Error('not expected'); }),
        };
        const repository = createSessionDraftRepository({ storage: createMemoryStorage(), cipher, syncEnabled: false });
        const listener = vi.fn();
        repository.subscribeSessionDraftList(inactiveScope, listener);
        let current = true;
        const hydration = repository.ensureSessionDraftRepositoryHydratedWithScopedRuntime({
            scope: inactiveScope,
            runtime: { transport, cipher },
            isCurrent: () => current,
        });
        await vi.waitFor(() => expect(transport.list).toHaveBeenCalledOnce());
        current = false;
        response.resolve({
            items: [{
                address,
                revision: 1,
                content: await cipher.seal(address, {
                    v: 1,
                    target: { kind: 'newSession', authoring: {} },
                    composer: {
                        text: { mutationId: 'text', value: 'retired credentials' },
                        mentions: { mutationId: 'mentions', value: [] },
                        attachments: { mutationId: 'attachments', value: [] },
                    },
                    extensions: {},
                }),
                createdAt: 1,
                updatedAt: 1,
            }],
            nextAfter: undefined,
        });
        await hydration;

        expect(repository.listNewSessionDraftProjections(inactiveScope)).toEqual([]);
        expect(listener).not.toHaveBeenCalled();
        expect(transport.read).not.toHaveBeenCalled();
    });

    it('deletes only the exact inactive scoped draft without using or mutating the active Home runtime', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000903' } as const;
        const inactiveScope = { serverId: 'server-b', accountId: 'account-b' } as const;
        const activeRemote = createRemote(address);
        const inactiveRemote = createRemote(address);
        const cipher = plainCipher();
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, transport: activeRemote.transport, cipher, syncEnabled: true,
        });
        repository.writeNewSessionDraft({ scope, draftId: address.draftId, patch: { text: 'active Home' }, materializationIntent: 'userEdit' });
        await repository.flushSessionDraft({ scope, address });
        const inactiveWriter = createSessionDraftRepository({
            storage: createMemoryStorage(), scope: inactiveScope, transport: inactiveRemote.transport, cipher, syncEnabled: true,
        });
        inactiveWriter.writeNewSessionDraft({
            scope: inactiveScope,
            draftId: address.draftId,
            patch: { text: 'inactive Home' },
            materializationIntent: 'userEdit',
        });
        await inactiveWriter.flushSessionDraft({ scope: inactiveScope, address });
        await repository.materializeExactWithScopedRuntime({
            scope: inactiveScope,
            address,
            runtime: { transport: inactiveRemote.transport, cipher },
            isCurrent: () => true,
        });
        vi.mocked(activeRemote.transport.mutate).mockClear();

        await expect(repository.deleteSessionDraftWithScopedRuntime({
            scope: inactiveScope,
            address,
            runtime: { transport: inactiveRemote.transport, cipher },
            isCurrent: () => true,
        })).resolves.toBe(true);

        expect(repository.getSessionDraftSnapshot(inactiveScope, address)).toBeNull();
        expect(requireComposerDraftDocument(repository.getSessionDraftSnapshot(scope, address)?.document)?.composer.text.value).toBe('active Home');
        expect(inactiveRemote.readCurrent()?.content).toBeNull();
        expect(activeRemote.transport.mutate).not.toHaveBeenCalled();
    });

    it('keeps the exact scoped row when delete retires during a late response', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000904' } as const;
        const inactiveScope = { serverId: 'server-b', accountId: 'account-b' } as const;
        const remote = createRemote(address);
        const cipher = plainCipher();
        const repository = createSessionDraftRepository({ storage: createMemoryStorage(), cipher, syncEnabled: false });
        repository.writeNewSessionDraft({
            scope: inactiveScope,
            draftId: address.draftId,
            patch: { text: 'recoverable waiting draft' },
            materializationIntent: 'userEdit',
        });
        const currentness = repository.captureSessionDraftCurrentness({ scope: inactiveScope, address });
        expect(currentness).not.toBeNull();
        const sealed = await cipher.seal(address, repository.getSessionDraftSnapshot(inactiveScope, address)!.document);
        remote.replaceCurrent({ revision: 1, content: sealed, createdAt: 1, updatedAt: 1 });
        await repository.materializeExactWithScopedRuntime({
            scope: inactiveScope, address, runtime: { transport: remote.transport, cipher }, isCurrent: () => true,
        });
        const release = createDeferred<void>();
        const mutate = remote.transport.mutate;
        const transport: SessionDraftRepositoryTransport = {
            ...remote.transport,
            mutate: vi.fn(async (request) => {
                await release.promise;
                return mutate(request);
            }),
        };
        let current = true;
        const deletion = repository.deleteSessionDraftWithScopedRuntime({
            scope: inactiveScope,
            address,
            runtime: { transport, cipher },
            isCurrent: () => current,
        });
        await vi.waitFor(() => expect(transport.mutate).toHaveBeenCalledOnce());
        current = false;
        release.resolve();

        await expect(deletion).resolves.toBe(false);
        expect(requireComposerDraftDocument(repository.getSessionDraftSnapshot(inactiveScope, address)?.document)?.composer.text.value)
            .toBe('recoverable waiting draft');
    });

    it('preserves a recoverable scoped row with truthful status when delete transport fails', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000905' } as const;
        const inactiveScope = { serverId: 'server-b', accountId: 'account-b' } as const;
        const cipher = plainCipher();
        const repository = createSessionDraftRepository({ storage: createMemoryStorage(), cipher, syncEnabled: false });
        repository.writeNewSessionDraft({
            scope: inactiveScope,
            draftId: address.draftId,
            patch: { text: 'retry cancellation later' },
            materializationIntent: 'userEdit',
        });
        const transport: SessionDraftRepositoryTransport = {
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            read: vi.fn(async () => ({ status: 'absent' as const })),
            mutate: vi.fn(async () => { throw new Error('offline'); }),
        };

        await expect(repository.deleteSessionDraftWithScopedRuntime({
            scope: inactiveScope,
            address,
            runtime: { transport, cipher },
            isCurrent: () => true,
        })).rejects.toThrow('offline');

        expect(repository.getSessionDraftSnapshot(inactiveScope, address)).toMatchObject({
            status: 'offline',
            document: { composer: { text: { value: 'retry cancellation later' } } },
        });
    });

    it('retains and rematerializes the exact scoped row when its delete revision conflicts', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000906' } as const;
        const inactiveScope = { serverId: 'server-b', accountId: 'account-b' } as const;
        const remote = createRemote(address);
        const cipher = plainCipher();
        const remoteDocument: SessionDraftDocumentV2 = {
            v: 1,
            target: { kind: 'newSession', authoring: {} },
            composer: {
                text: { mutationId: 'text', value: 'newer remote waiting draft' },
                mentions: { mutationId: 'mentions', value: [] },
                attachments: { mutationId: 'attachments', value: [] },
            },
            extensions: {},
        };
        remote.replaceCurrent({
            revision: 2,
            content: await cipher.seal(address, remoteDocument),
            createdAt: 1,
            updatedAt: 2,
        });
        const repository = createSessionDraftRepository({ storage: createMemoryStorage(), cipher, syncEnabled: false });
        await repository.materializeExactWithScopedRuntime({
            scope: inactiveScope, address, runtime: { transport: remote.transport, cipher }, isCurrent: () => true,
        });
        const transport: SessionDraftRepositoryTransport = {
            ...remote.transport,
            mutate: vi.fn(async () => ({
                status: 'conflict' as const,
                current: { address, ...remote.readCurrent()! },
            })),
        };

        await expect(repository.deleteSessionDraftWithScopedRuntime({
            scope: inactiveScope,
            address,
            runtime: { transport, cipher },
            isCurrent: () => true,
        })).resolves.toBe(false);

        expect(repository.getSessionDraftSnapshot(inactiveScope, address)).toMatchObject({
            status: 'clean',
            document: { composer: { text: { value: 'newer remote waiting draft' } } },
        });
        expect(transport.read).toHaveBeenCalledWith(address);
    });

    it('writes one canonical V2 newSession document and no predecessor mutation', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000010' } as const;
        const remote = createRemote(address);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: remote.transport,
            cipher: createSessionDraftCipher({
                accountMode: 'plain', accountCryptoMaterial: null, getSessionContext: () => null,
                randomBytes: (length) => new Uint8Array(length),
            }),
            syncEnabled: true,
        });
        const target = {
            kind: 'machine' as const,
            target: { serverId: scope.serverId, machineId: 'machine-a' },
            selectionOrigin: { kind: 'machine_pool' as const, poolId: '11111111-1111-4111-8111-111111111111' },
        };
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            materializationIntent: 'userEdit',
            patch: { text: 'run here', authoring: { executionTarget: target, runtimeDescriptorV1: null } },
        });

        expect(await repository.flushSessionDraft({ scope, address })).toEqual({ status: 'clean' });
        // 0.3 is a one-way upgrade: the write carries the canonical V2 document
        // and nothing else. There is no second predecessor projection to prepare.
        const request = vi.mocked(remote.transport.mutate).mock.calls[0]?.[0];
        expect(request).toMatchObject({
            address,
            content: {
                t: 'plain',
                v: {
                    v: 2,
                    address,
                    document: {
                        v: 2,
                        target: { kind: 'newSession', authoring: { executionTarget: { value: target } } },
                    },
                },
            },
        });
    });

    it('treats re-reading an unchanged server draft as no change: same projection, no notification', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000031' } as const;
        const remote = createRemote(address);
        const author = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, transport: remote.transport, cipher: plainCipher(), syncEnabled: true,
        });
        author.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'kept draft' } });
        expect(await author.flushSessionDraft({ scope, address })).toEqual({ status: 'clean' });

        const observer = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, transport: remote.transport, cipher: plainCipher(), syncEnabled: true,
        });
        await observer.materializeExact(scope, address);
        const listed = observer.listNewSessionDraftProjections(scope);
        expect(listed).toHaveLength(1);
        const listener = vi.fn();
        const unsubscribe = observer.subscribeSessionDraftList(scope, listener);

        // The sync feed can report the same draft again (a repeated change, a reconnect catch-up).
        // Reading the same revision back must not look like an edit to every draft list subscriber.
        await observer.materializeExact(scope, address);
        await observer.materializeExact(scope, address);

        expect(observer.listNewSessionDraftProjections(scope)).toBe(listed);
        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('keeps a Temporary computer draft visible and preserves independent cross-device edits through the real cipher', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000010' } as const;
        const remote = createRemote(address);
        const cipher = createSessionDraftCipher({
            accountMode: 'plain', accountCryptoMaterial: null, getSessionContext: () => null,
            randomBytes: (length) => new Uint8Array(length),
        });
        const create = () => createSessionDraftRepository({
            storage: createMemoryStorage(), scope, transport: remote.transport, cipher, syncEnabled: true,
        });
        const first = create();
        const target = { kind: 'temporary_computer', serverId: scope.serverId, artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } } as const;
        const activationRef = { v: 1, activationId: '00000000-0000-4000-8000-000000000020', createdOnDeviceLabel: 'My laptop' } as const;
        first.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: {
            text: 'original', authoring: { executionTarget: target, temporaryComputerActivationRef: activationRef },
        } });
        expect(await first.flushSessionDraft({ scope, address })).toEqual({ status: 'clean' });
        expect(first.listNewSessionDraftProjections(scope)).toHaveLength(1);
        const second = create();
        await second.materializeExact(scope, address);
        const captured = first.captureSessionDraftCurrentness({ scope, address });
        second.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: {
            authoring: { temporaryComputerActivationRef: { ...activationRef, createdOnDeviceLabel: 'Renamed laptop' } },
        } });
        await second.flushSessionDraft({ scope, address });
        first.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: { text: 'newer local prompt' } });
        expect(await first.flushSessionDraft({ scope, address })).toEqual({ status: 'clean' });
        expect(first.getSessionDraftSnapshot(scope, address)?.document).toMatchObject({
            v: 2,
            composer: { text: { value: 'newer local prompt' } },
            target: { kind: 'newSession', authoring: {
                executionTarget: { value: target },
                temporaryComputerActivationRef: { value: { ...activationRef, createdOnDeviceLabel: 'Renamed laptop' } },
            } },
        });
        await first.clearSessionDraftCurrentness({ scope, address, currentness: captured });
        expect(first.getSessionDraftSnapshot(scope, address)?.document).toMatchObject({
            composer: { text: { value: 'newer local prompt' } },
            target: { authoring: { temporaryComputerActivationRef: { value: { createdOnDeviceLabel: 'Renamed laptop' } } } },
        });
    });

    it('returns the canonical unavailable result and retains successor fields when the peer cannot sync them', async () => {
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000010' } as const;
        const remote = createRemote(address);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(), scope,
            transport: { ...remote.transport, mutate: async () => { throw new SessionDraftEpochUnavailableError(); } },
            cipher: createSessionDraftCipher({
                accountMode: 'plain', accountCryptoMaterial: null, getSessionContext: () => null,
                randomBytes: (length) => new Uint8Array(length),
            }),
            syncEnabled: true,
        });
        const target = { kind: 'temporary_computer', serverId: scope.serverId, artifactTarget: 'linux-x64', workspace: { kind: 'endpoint_home' } } as const;
        repository.writeNewSessionDraft({ scope, draftId: address.draftId, materializationIntent: 'userEdit', patch: {
            text: 'retain on this device', authoring: { executionTarget: target },
        } });
        expect(await repository.flushSessionDraft({ scope, address })).toEqual({ status: 'error', code: 'session_draft_epoch_unavailable' });
        // A Home that cannot serve the V2 draft epoch is a permanent, explainable
        // state, not the generic sync error, so the replica carries its own status.
        expect(repository.getSessionDraftSnapshot(scope, address)?.status).toBe('unsupported');
        expect(repository.getSessionDraftSnapshot(scope, address)?.document).toMatchObject({
            composer: { text: { value: 'retain on this device' } }, target: { authoring: { executionTarget: { value: target } } },
        });
        expect(remote.readCurrent()).toBeNull();
    });

    it('synchronizes a Run draft through the same repository, cipher and CAS transport', async () => {
        const remote = createRemote(runAddress);
        const cipher = plainCipher();
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: remote.transport,
            cipher,
            syncEnabled: true,
        });
        repository.writeExistingSessionDraft({
            scope,
            sessionId: runAddress.sessionId,
            runId: runAddress.runId,
            patch: { text: 'ask the run' },
        });
        expect(await repository.flushSessionDraft({ scope, address: runAddress })).toEqual({ status: 'clean' });

        const stored = remote.readCurrent();
        expect(stored?.revision).toBe(0);
        expect(stored?.content?.t).toBe('plain');
        expect(cipher.seal).toHaveBeenCalledWith(runAddress, expect.objectContaining({ v: 1 }));
        const snapshot = repository.getSessionDraftSnapshot(scope, runAddress);
        expect(requireComposerDraftDocument(snapshot?.document)?.composer.text.value).toBe('ask the run');
        expect(snapshot?.document.target).toMatchObject({
            kind: 'session',
            routing: {
                recipient: {
                    value: { mode: 'manual', recipient: { kind: 'execution_run', runId: runAddress.runId } },
                },
            },
        });
    });

    it('keeps human discussion drafts on the human document with a new-discussion title', async () => {
        const remote = createRemote(newDiscussionAddress);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: remote.transport,
            cipher: plainCipher(),
            syncEnabled: true,
        });
        repository.writeDiscussionSessionDraft({
            scope,
            address: newDiscussionAddress,
            patch: { text: 'about the release', title: 'Release plan' },
        });
        expect(await repository.flushSessionDraft({ scope, address: newDiscussionAddress })).toEqual({ status: 'clean' });
        const snapshot = repository.getSessionDraftSnapshot(scope, newDiscussionAddress);
        expect(snapshot?.document).toMatchObject({
            v: 2,
            target: { kind: 'newDiscussion' },
            composer: { text: { value: 'about the release' } },
            title: { value: 'Release plan' },
        });

        const discussionRemote = createRemote(discussionAddress);
        const discussionRepository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: discussionRemote.transport,
            cipher: plainCipher(),
            syncEnabled: true,
        });
        discussionRepository.writeDiscussionSessionDraft({
            scope,
            address: discussionAddress,
            patch: { text: 'reply' },
        });
        expect(await discussionRepository.flushSessionDraft({ scope, address: discussionAddress }))
            .toEqual({ status: 'clean' });
        expect(discussionRepository.getSessionDraftSnapshot(scope, discussionAddress)?.document)
            .toMatchObject({ v: 2, target: { kind: 'discussion' } });
    });

    it('preserves both the newer synchronized edit and the newer local edit on a Run draft conflict', async () => {
        const remote = createRemote(runAddress);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: remote.transport,
            cipher: plainCipher(),
            syncEnabled: true,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: runAddress.sessionId, runId: runAddress.runId, patch: { text: 'first' } });
        await repository.flushSessionDraft({ scope, address: runAddress });

        const base = remote.readCurrent()!;
        const remoteDocument = SessionDraftDocumentV1Schema.parse(
            (base.content as Extract<SessionDraftStoredContentEnvelopeV2, { t: 'plain' }>).v.document,
        );
        remoteDocument.composer.attachments = { mutationId: '00000000-0000-4000-8000-0000000000a1', value: [{ id: 'from-another-device' }] };
        remote.replaceCurrent({
            revision: base.revision + 1,
            content: { t: 'plain', v: { v: 2, address: runAddress, document: remoteDocument } },
            createdAt: base.createdAt,
            updatedAt: base.updatedAt + 1,
        });

        repository.writeExistingSessionDraft({ scope, sessionId: runAddress.sessionId, runId: runAddress.runId, patch: { text: 'second' } });
        expect(await repository.flushSessionDraft({ scope, address: runAddress })).toEqual({ status: 'clean' });
        const snapshot = repository.getSessionDraftSnapshot(scope, runAddress);
        expect(requireComposerDraftDocument(snapshot?.document)?.composer.text.value).toBe('second');
        expect(requireComposerDraftDocument(snapshot?.document)?.composer.attachments.value).toEqual([{ id: 'from-another-device' }]);
        expect(snapshot?.conflict).toBeNull();
    });

    it('retains unsent content when the V2 draft epoch is unavailable', async () => {
        const remote = createRemote(runAddress);
        const unavailable: SessionDraftRepositoryTransport = {
            ...remote.transport,
            mutate: vi.fn(async () => { throw new Error('Session draft V2 operations are unavailable'); }),
        };
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: unavailable,
            cipher: plainCipher(),
            syncEnabled: true,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: runAddress.sessionId, runId: runAddress.runId, patch: { text: 'unsent' } });
        expect(await repository.flushSessionDraft({ scope, address: runAddress })).toEqual({ status: 'offline' });
        const snapshot = repository.getSessionDraftSnapshot(scope, runAddress);
        expect(requireComposerDraftDocument(snapshot?.document)?.composer.text.value).toBe('unsent');
        expect(snapshot?.status).toBe('offline');
        expect(remote.readCurrent()).toBeNull();
    });

    it('deletes a Run or discussion draft through the existing lifecycle owner', async () => {
        const remote = createRemote(discussionAddress);
        const onDraftRemoved = vi.fn(async () => undefined);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: remote.transport,
            cipher: plainCipher(),
            syncEnabled: true,
            onDraftRemoved,
        });
        repository.writeDiscussionSessionDraft({ scope, address: discussionAddress, patch: { text: 'draft' } });
        await repository.flushSessionDraft({ scope, address: discussionAddress });
        await expect(repository.deleteSessionDraft({ scope, address: discussionAddress })).resolves.toBe(true);
        expect(repository.getSessionDraftSnapshot(scope, discussionAddress)).toBeNull();
        expect(remote.readCurrent()?.content).toBeNull();
        await vi.waitFor(() => expect(onDraftRemoved).toHaveBeenCalledWith(expect.objectContaining({
            scope,
            address: discussionAddress,
        })));
    });

    it('keeps an acknowledged tombstone visible and retryable until authoritative custody cleanup succeeds', async () => {
        const remote = createRemote(discussionAddress);
        const onDraftRemoved = vi.fn()
            .mockRejectedValueOnce(new Error('local custody busy'))
            .mockResolvedValueOnce(undefined);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: remote.transport,
            cipher: plainCipher(),
            syncEnabled: true,
            onDraftRemoved,
        });
        repository.writeDiscussionSessionDraft({ scope, address: discussionAddress, patch: { text: 'draft' } });
        await repository.flushSessionDraft({ scope, address: discussionAddress });

        await expect(repository.deleteSessionDraft({ scope, address: discussionAddress }))
            .rejects.toThrow('local custody busy');
        expect(remote.readCurrent()?.content).toBeNull();
        expect(repository.getSessionDraftSnapshot(scope, discussionAddress)).toMatchObject({ status: 'error' });

        await expect(repository.deleteSessionDraft({ scope, address: discussionAddress })).resolves.toBe(false);
        expect(repository.getSessionDraftSnapshot(scope, discussionAddress)).toBeNull();
        expect(onDraftRemoved).toHaveBeenCalledTimes(2);
    });

    it('publishes authoritative removal when another device tombstones the draft', async () => {
        const remote = createRemote(discussionAddress);
        const first = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, transport: remote.transport, cipher: plainCipher(), syncEnabled: true,
        });
        const onDraftRemoved = vi.fn(async () => undefined);
        const observer = createSessionDraftRepository({
            storage: createMemoryStorage(), scope, transport: remote.transport, cipher: plainCipher(), syncEnabled: true,
            onDraftRemoved,
        });
        first.writeDiscussionSessionDraft({ scope, address: discussionAddress, patch: { text: 'cross-device draft' } });
        await first.flushSessionDraft({ scope, address: discussionAddress });
        await observer.materializeExact(scope, discussionAddress);

        await expect(first.deleteSessionDraft({ scope, address: discussionAddress })).resolves.toBe(true);
        await observer.materializeExact(scope, discussionAddress);

        expect(observer.getSessionDraftSnapshot(scope, discussionAddress)).toBeNull();
        await vi.waitFor(() => expect(onDraftRemoved).toHaveBeenCalledWith(expect.objectContaining({
            scope,
            address: discussionAddress,
        })));
    });

    it('purges revoked discussion presentation without authoring a remote deletion', async () => {
        const remote = createRemote(discussionAddress);
        const onDraftRemoved = vi.fn(async () => undefined);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: remote.transport,
            cipher: plainCipher(),
            syncEnabled: true,
            onDraftRemoved,
        });
        repository.writeDiscussionSessionDraft({ scope, address: discussionAddress, patch: { text: 'private draft' } });
        await repository.flushSessionDraft({ scope, address: discussionAddress });
        vi.mocked(remote.transport.mutate).mockClear();

        await repository.purgeSessionDraftPresentation({ scope, address: discussionAddress });

        expect(repository.getSessionDraftSnapshot(scope, discussionAddress)).toBeNull();
        expect(remote.transport.mutate).not.toHaveBeenCalled();
        expect(remote.readCurrent()?.content).not.toBeNull();
        expect(onDraftRemoved).not.toHaveBeenCalled();
    });
});
