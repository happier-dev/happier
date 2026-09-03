import { describe, expect, it, vi } from 'vitest';
import type {
    SessionDraftAddressV1,
    SessionDraftDocumentV1,
    SessionDraftStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import { canonicalSessionDraftAddressV1, SessionDraftDocumentV1Schema } from '@happier-dev/protocol';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import {
    createSessionDraftRepository,
    type SessionDraftRepositoryCipher,
    type SessionDraftRepositoryTransport,
} from './sessionDraftRepository';
import { SessionDraftContextUnavailableError } from './sessionDraftCipherError';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const sessionAddress = { kind: 'session', sessionId: 'session-a' } as const;
type ExistingSessionDraftDocument = SessionDraftDocumentV1 & {
    target: Extract<SessionDraftDocumentV1['target'], { kind: 'session' }>;
};
type NewSessionDraftDocument = SessionDraftDocumentV1 & {
    target: Extract<SessionDraftDocumentV1['target'], { kind: 'newSession' }>;
};

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
        seal: vi.fn(async (_address: SessionDraftAddressV1, document: SessionDraftDocumentV1) => ({ t: 'plain' as const, v: {
            v: 1 as const,
            address: _address,
            document,
        } })),
        open: vi.fn(async (address: SessionDraftAddressV1, content: SessionDraftStoredContentEnvelopeV1) => {
            if (content.t !== 'plain') return null;
            expect(content.v.address).toEqual(address);
            return content.v.document;
        }),
    };
}

function createRemote(
    initial?: Readonly<{ revision: number; content: SessionDraftStoredContentEnvelopeV1 | null; createdAt: number; updatedAt: number }>,
    address: SessionDraftAddressV1 = sessionAddress,
) {
    let current: { revision: number; content: SessionDraftStoredContentEnvelopeV1 | null; createdAt: number; updatedAt: number } | null = initial ? { ...initial } : null;
    const transport: SessionDraftRepositoryTransport = {
        read: vi.fn(async () => {
            if (!current) return { status: 'absent' as const };
            if (current.content === null) return { status: 'deleted' as const, record: { ...current, address } };
            return { status: 'present' as const, record: { ...current, address } };
        }),
        list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
        mutate: vi.fn(async ({ expectedRevision, content }) => {
            const currentRevision = current?.revision ?? 'absent';
            if (currentRevision !== expectedRevision) {
                return {
                    status: 'conflict' as const,
                    current: current
                        ? { address, ...current }
                        : { status: 'absent' as const },
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
    return {
        transport,
        readCurrent: () => current,
        replaceCurrent: (next: NonNullable<typeof current>) => { current = next; },
    };
}

function uuid(value: number): string {
    return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

describe('sessionDraftRepository', () => {
    it('does not notify or replace a materialized replica for a same-value user edit', () => {
        const address = { kind: 'newSession', draftId: uuid(300) } as const;
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            syncEnabled: true,
            transport: createRemote(undefined, address).transport,
            cipher: plainCipher(),
            randomUUID: () => uuid(301),
            now: () => 10,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'hello' },
            materializationIntent: 'userEdit',
        });
        const before = repository.getSessionDraftSnapshot(scope, address);
        const listener = vi.fn();
        repository.subscribeSessionDraft(scope, address, listener);

        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'hello' },
            materializationIntent: 'userEdit',
        });

        expect(repository.getSessionDraftSnapshot(scope, address)).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    it('persists the ordinary-entry pointer per Account/server scope and clears only its exact deleted draft', async () => {
        const storage = createMemoryStorage();
        const firstDraftId = uuid(301);
        const secondDraftId = uuid(302);
        const repository = createSessionDraftRepository({
            storage,
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(303),
            now: () => 10,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: firstDraftId,
            patch: { text: 'Ordinary draft' },
            materializationIntent: 'userEdit',
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: secondDraftId,
            patch: { text: 'Explicit draft' },
            materializationIntent: 'userEdit',
        });

        expect(repository.setOrdinaryEntryDraftId(scope, firstDraftId)).toBe(true);
        expect(repository.readOrdinaryEntryDraftId(scope)).toBe(firstDraftId);
        expect(repository.readOrdinaryEntryDraftId({ serverId: 'server-b', accountId: 'account-a' })).toBeNull();
        expect(repository.readOrdinaryEntryDraftId({ serverId: 'server-a', accountId: 'account-b' })).toBeNull();
        expect(repository.clearOrdinaryEntryDraftIdExact(scope, secondDraftId)).toBe(false);
        expect(repository.readOrdinaryEntryDraftId(scope)).toBe(firstDraftId);

        const restored = createSessionDraftRepository({
            storage,
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(304),
            now: () => 20,
        });
        expect(restored.readOrdinaryEntryDraftId(scope)).toBe(firstDraftId);

        await restored.deleteSessionDraft({
            scope,
            address: { kind: 'newSession', draftId: firstDraftId },
        });
        expect(restored.readOrdinaryEntryDraftId(scope)).toBeNull();
        expect(restored.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: secondDraftId })).not.toBeNull();
    });

    it('does not point ordinary entry at a missing or untouched draft identity', () => {
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(305),
            now: () => 10,
        });

        expect(repository.setOrdinaryEntryDraftId(scope, uuid(306))).toBe(false);
        expect(repository.readOrdinaryEntryDraftId(scope)).toBeNull();
    });

    it('persists local edits immediately and isolates Account/server scopes in local-only mode', async () => {
        const storage = createMemoryStorage();
        const repository = createSessionDraftRepository({
            storage,
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(1),
            now: () => 10,
        });

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'local text' } });
        await repository.flushSessionDraft({ scope, address: sessionAddress });

        const restored = createSessionDraftRepository({
            storage,
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(2),
            now: () => 20,
        });
        expect(restored.getSessionDraftSnapshot(scope, sessionAddress)?.document.composer.text.value).toBe('local text');
        expect(restored.getSessionDraftSnapshot({ serverId: 'server-b', accountId: 'account-a' }, sessionAddress)).toBeNull();
    });

    it('rebases distinct-field edits and preserves unknown extension fields', async () => {
        const cipher = plainCipher();
        const baseDocument: ExistingSessionDraftDocument = {
            v: 1,
            composer: {
                text: { mutationId: uuid(10), value: 'base' },
                mentions: { mutationId: uuid(11), value: [] },
                attachments: { mutationId: uuid(12), value: [] },
            },
            target: { kind: 'session', routing: {
                recipient: { mutationId: uuid(13), value: null },
                agentContinuation: { mutationId: uuid(14), value: null },
                executionRunDelivery: { mutationId: uuid(15), value: null },
            } },
            extensions: { futurePlugin: { futureField: { mutationId: uuid(16), value: { future: true } } } },
        };
        const remoteDocument = structuredClone(baseDocument);
        remoteDocument.target.routing.recipient = { mutationId: uuid(17), value: { kind: 'user', userId: 'u2' } };
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, baseDocument),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(18),
            now: () => 3,
        });
        await repository.materializeExact(scope, sessionAddress);
        remote.replaceCurrent({
            revision: 2,
            content: await cipher.seal(sessionAddress, remoteDocument),
            createdAt: 1,
            updatedAt: 2,
        });

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'mine' } });
        await repository.flushSessionDraft({ scope, address: sessionAddress });

        const snapshot = repository.getSessionDraftSnapshot(scope, sessionAddress)!;
        expect(snapshot.status).toBe('clean');
        expect(snapshot.document.composer.text.value).toBe('mine');
        if (snapshot.document.target.kind !== 'session') throw new Error('expected existing-session snapshot');
        expect(snapshot.document.target.routing.recipient.value).toEqual({ kind: 'user', userId: 'u2' });
        expect(snapshot.document.extensions.futurePlugin.futureField.value).toEqual({ future: true });
    });

    it('stays pending after one immediate rebase retry loses another CAS race', async () => {
        const cipher = plainCipher();
        const baseDocument = createSessionDocument('base', uuid(190));
        let revision = 1;
        const transport: SessionDraftRepositoryTransport = {
            read: vi.fn(async () => ({
                status: 'present' as const,
                record: {
                    address: sessionAddress,
                    revision: 1,
                    content: await cipher.seal(sessionAddress, baseDocument),
                    createdAt: 1,
                    updatedAt: 1,
                },
            })),
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            mutate: vi.fn(async () => {
                revision += 1;
                const current = structuredClone(baseDocument);
                current.target.routing.agentContinuation = { mutationId: uuid(190 + revision), value: { revision } };
                return {
                    status: 'conflict' as const,
                    current: {
                        address: sessionAddress,
                        revision,
                        content: await cipher.seal(sessionAddress, current),
                        createdAt: 1,
                        updatedAt: revision,
                    },
                };
            }),
        };
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(199),
            now: () => 2,
        });
        await repository.materializeExact(scope, sessionAddress);
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'mine' } });

        expect(await repository.flushSessionDraft({ scope, address: sessionAddress })).toEqual({ status: 'pending' });
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)?.status).toBe('pending');
        expect(transport.mutate).toHaveBeenCalledTimes(2);
    });

    it('retains same-field concurrent values as an explicit reload-durable conflict', async () => {
        const cipher = plainCipher();
        const baseDocument = createSessionDocument('base', uuid(20));
        const remoteDocument = createSessionDocument('theirs', uuid(21));
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, baseDocument),
            createdAt: 1,
            updatedAt: 1,
        });
        const storage = createMemoryStorage();
        const repository = createSessionDraftRepository({
            storage,
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(22),
            now: () => 3,
        });
        await repository.materializeExact(scope, sessionAddress);
        remote.replaceCurrent({
            revision: 2,
            content: await cipher.seal(sessionAddress, remoteDocument),
            createdAt: 1,
            updatedAt: 2,
        });

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'mine' } });
        await repository.flushSessionDraft({ scope, address: sessionAddress });
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'conflict',
            conflict: { fields: [{ fieldId: 'composer.text', mine: 'mine', synced: 'theirs' }] },
        });

        const restored = createSessionDraftRepository({
            storage,
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(23),
            now: () => 4,
        });
        expect(restored.getSessionDraftSnapshot(scope, sessionAddress)?.status).toBe('conflict');
    });

    it('uses the synced value and clears the selected field conflict without writing it back', async () => {
        const cipher = plainCipher();
        const baseDocument = createSessionDocument('base', uuid(200));
        const remoteDocument = createSessionDocument('synced', uuid(201));
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, baseDocument),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(202),
            now: () => 3,
        });
        await repository.materializeExact(scope, sessionAddress);
        remote.replaceCurrent({
            revision: 2,
            content: await cipher.seal(sessionAddress, remoteDocument),
            createdAt: 1,
            updatedAt: 2,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'mine' } });
        await repository.flushSessionDraft({ scope, address: sessionAddress });
        const writesBeforeResolution = vi.mocked(remote.transport.mutate).mock.calls.length;

        await repository.resolveSessionDraftConflict({
            scope,
            address: sessionAddress,
            fieldId: 'composer.text',
            action: 'useSynced',
        });

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'clean',
            conflict: null,
            document: { composer: { text: { mutationId: uuid(201), value: 'synced' } } },
        });
        expect(vi.mocked(remote.transport.mutate)).toHaveBeenCalledTimes(writesBeforeResolution);
    });

    it('retokens Keep device and CAS-writes it against the current synced revision', async () => {
        const cipher = plainCipher();
        const baseDocument = createSessionDocument('base', uuid(210));
        const remoteDocument = createSessionDocument('synced', uuid(211));
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, baseDocument),
            createdAt: 1,
            updatedAt: 1,
        });
        const generated = [uuid(212), uuid(213), uuid(214), uuid(215), uuid(216), uuid(217), uuid(218)];
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => generated.shift() ?? uuid(219),
            now: () => 3,
        });
        await repository.materializeExact(scope, sessionAddress);
        remote.replaceCurrent({
            revision: 2,
            content: await cipher.seal(sessionAddress, remoteDocument),
            createdAt: 1,
            updatedAt: 2,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'mine' } });
        await repository.flushSessionDraft({ scope, address: sessionAddress });
        const mineBeforeResolution = repository.getSessionDraftSnapshot(scope, sessionAddress)!.document.composer.text.mutationId;

        await repository.resolveSessionDraftConflict({
            scope,
            address: sessionAddress,
            fieldId: 'composer.text',
            action: 'keepDevice',
        });

        const snapshot = repository.getSessionDraftSnapshot(scope, sessionAddress)!;
        expect(snapshot).toMatchObject({
            status: 'clean',
            conflict: null,
            document: { composer: { text: { value: 'mine' } } },
        });
        expect(snapshot.document.composer.text.mutationId).not.toBe(mineBeforeResolution);
        expect(vi.mocked(remote.transport.mutate).mock.calls.at(-1)?.[0]).toMatchObject({ expectedRevision: 2 });
        expect(remote.readCurrent()).toMatchObject({ revision: 3 });
    });

    it('requeues an authoring-field deletion when Keep device resolves its conflict', async () => {
        const cipher = plainCipher();
        const address = { kind: 'newSession', draftId: uuid(205) } as const;
        const storage = createMemoryStorage();
        const seedingRepository = createSessionDraftRepository({
            storage,
            syncEnabled: false,
            cipher,
            randomUUID: () => uuid(206),
            now: () => 1,
        });
        seedingRepository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { authoring: { machineId: 'mine' } },
            materializationIntent: 'userEdit',
        });
        const storageKey = [...storage.values.keys()][0]!;
        const persisted = JSON.parse(storage.values.get(storageKey)!) as {
            replicas: Record<string, Record<string, unknown>>;
        };
        const replica = persisted.replicas[canonicalSessionDraftAddressV1(address)]!;
        const original = SessionDraftDocumentV1Schema.parse(replica.localRawDocument);
        assertNewSessionDocument(original);
        const baseMutationId = original.target.authoring.machineId!.mutationId;
        const remoteDocument = structuredClone(original);
        remoteDocument.target.authoring.machineId = { mutationId: uuid(207), value: 'synced' };
        const localDocument = structuredClone(remoteDocument);
        delete localDocument.target.authoring.machineId;
        Object.assign(replica, {
            baseRevision: 2,
            baseRawDocument: remoteDocument,
            localRawDocument: localDocument,
            pendingFieldMutations: [{
                path: { kind: 'authoring', fieldId: 'machineId' },
                mutationId: uuid(208),
                intent: 'edit',
                baseMutationId,
                field: null,
            }],
            status: 'conflict',
            conflict: {
                fields: [{
                    fieldId: 'target.authoring.machineId',
                    path: { kind: 'authoring', fieldId: 'machineId' },
                    mine: null,
                    synced: 'synced',
                }],
            },
        });
        storage.set(storageKey, JSON.stringify(persisted));
        const remote = createRemote({
            revision: 2,
            content: await cipher.seal(address, remoteDocument),
            createdAt: 1,
            updatedAt: 2,
        }, address);
        const repository = createSessionDraftRepository({
            storage,
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(209),
            now: () => 3,
        });

        await repository.resolveSessionDraftConflict({
            scope,
            address,
            fieldId: 'target.authoring.machineId',
            action: 'keepDevice',
        });

        const snapshot = repository.getSessionDraftSnapshot(scope, address)!;
        expect(snapshot.status).toBe('clean');
        expect(snapshot.document.target.kind).toBe('newSession');
        if (snapshot.document.target.kind !== 'newSession') throw new Error('expected new-session snapshot');
        expect(snapshot.document.target.authoring.machineId).toBeUndefined();
        expect(vi.mocked(remote.transport.mutate).mock.calls.at(-1)?.[0]).toMatchObject({ expectedRevision: 2 });
    });

    it('does not resurrect a remotely deleted draft when a stale offline writer reconnects', async () => {
        const cipher = plainCipher();
        const baseDocument = createSessionDocument('base', uuid(220));
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, baseDocument),
            createdAt: 1,
            updatedAt: 1,
        });
        const deletingRepository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(221),
            now: () => 2,
        });
        const staleRepository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(222),
            now: () => 3,
        });
        await deletingRepository.materializeExact(scope, sessionAddress);
        await staleRepository.materializeExact(scope, sessionAddress);

        await deletingRepository.deleteSessionDraft({ scope, address: sessionAddress });
        staleRepository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'stale edit' } });
        await staleRepository.flushSessionDraft({ scope, address: sessionAddress });

        expect(remote.readCurrent()).toMatchObject({ revision: 2, content: null });
        expect(staleRepository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'conflict',
            conflict: { fields: [{ fieldId: 'composer.text', mine: 'stale edit', synced: null }] },
        });
    });

    it('protects A -> B -> A submission currentness by mutation token', async () => {
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: (() => {
                const values = [uuid(30), uuid(31), uuid(32), uuid(33), uuid(34), uuid(35), uuid(36), uuid(37), uuid(38)];
                return () => values.shift() ?? uuid(39);
            })(),
            now: () => 5,
        });

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'A' } });
        const captured = repository.captureSessionDraftCurrentness({ scope, address: sessionAddress });
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'B' } });
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'A' } });

        await repository.clearSessionDraftCurrentness({ scope, address: sessionAddress, currentness: captured });
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)?.document.composer.text.value).toBe('A');
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)?.document.composer.text.mutationId).toBe(uuid(38));
    });

    it('CAS-tombstones a new-session draft when successful launch currentness clears every meaningful field', async () => {
        const cipher = plainCipher();
        const address = { kind: 'newSession', draftId: uuid(240) } as const;
        const remote = createRemote(undefined, address);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: (() => {
                let next = 241;
                return () => uuid(next++);
            })(),
            now: () => 4,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'launch me', authoring: { machineId: 'machine-a' } },
            materializationIntent: 'userEdit',
        });
        expect(repository.setOrdinaryEntryDraftId(scope, address.draftId)).toBe(true);
        await repository.flushSessionDraft({ scope, address });
        const currentness = repository.captureSessionDraftCurrentness({ scope, address });

        expect(await repository.clearSessionDraftCurrentness({ scope, address, currentness })).toBe(true);

        expect(repository.getSessionDraftSnapshot(scope, address)).toBeNull();
        expect(repository.readOrdinaryEntryDraftId(scope)).toBeNull();
        expect(repository.listNewSessionDraftProjections(scope)).toEqual([]);
        expect(remote.readCurrent()).toMatchObject({ revision: 1, content: null });
        expect(vi.mocked(remote.transport.mutate).mock.calls.at(-1)?.[0]).toMatchObject({ expectedRevision: 0, content: null });
    });

    it('removes a local-only new-session replica when launch currentness clears every meaningful field', async () => {
        const address = { kind: 'newSession', draftId: uuid(245) } as const;
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(246),
            now: () => 4,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'launch me' },
            materializationIntent: 'userEdit',
        });
        const currentness = repository.captureSessionDraftCurrentness({ scope, address });

        await repository.clearSessionDraftCurrentness({ scope, address, currentness });

        expect(repository.getSessionDraftSnapshot(scope, address)).toBeNull();
        expect(repository.listNewSessionDraftProjections(scope)).toEqual([]);
    });

    it('preserves a new-session draft when a newer meaningful mutation survives currentness clearing', async () => {
        const address = { kind: 'newSession', draftId: uuid(250) } as const;
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: (() => {
                let next = 251;
                return () => uuid(next++);
            })(),
            now: () => 5,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'captured', authoring: { machineId: 'machine-a' } },
            materializationIntent: 'userEdit',
        });
        expect(repository.setOrdinaryEntryDraftId(scope, address.draftId)).toBe(true);
        const currentness = repository.captureSessionDraftCurrentness({ scope, address });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'newer edit' },
            materializationIntent: 'userEdit',
        });

        expect(await repository.clearSessionDraftCurrentness({ scope, address, currentness })).toBe(true);

        expect(repository.getSessionDraftSnapshot(scope, address)).toMatchObject({
            materialized: true,
            document: { composer: { text: { value: 'newer edit' } } },
        });
        expect(repository.listNewSessionDraftProjections(scope)).toHaveLength(1);
        expect(repository.readOrdinaryEntryDraftId(scope)).toBeNull();
    });

    it('clears ordinary-entry authority after a successful launch with no captured draft fields', async () => {
        const address = { kind: 'newSession', draftId: uuid(254) } as const;
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(255),
            now: () => 5,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'surviving draft' },
            materializationIntent: 'userEdit',
        });
        expect(repository.setOrdinaryEntryDraftId(scope, address.draftId)).toBe(true);

        expect(await repository.clearSessionDraftCurrentness({
            scope,
            address,
            currentness: { address, mutationIds: {} },
        })).toBe(false);

        expect(repository.readOrdinaryEntryDraftId(scope)).toBeNull();
        expect(repository.getSessionDraftSnapshot(scope, address)?.document.composer.text.value).toBe('surviving draft');
    });

    it('restores launch currentness after reload, preserves a newer edit, and clears the completed capture', async () => {
        const address = { kind: 'newSession', draftId: uuid(255) } as const;
        const storage = createMemoryStorage();
        const repository = createSessionDraftRepository({
            storage,
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: (() => {
                let next = 256;
                return () => uuid(next++);
            })(),
            now: () => 5,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'captured launch text', authoring: { machineId: 'machine-a' } },
            materializationIntent: 'launchInterrupted',
        });
        await repository.flushSessionDraft({ scope, address });
        const captured = repository.captureSessionDraftLaunchCurrentness({
            scope,
            address,
            userAttemptId: 'attempt-1',
        });
        expect(captured).not.toBeNull();
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'newer edit after launch' },
            materializationIntent: 'userEdit',
        });

        const restored = createSessionDraftRepository({
            storage,
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(299),
            now: () => 6,
        });
        expect(restored.readSessionDraftLaunchCurrentness({
            scope,
            address,
            userAttemptId: 'other-attempt',
        })).toBeNull();
        const restoredCurrentness = restored.readSessionDraftLaunchCurrentness({
            scope,
            address,
            userAttemptId: 'attempt-1',
        });
        expect(restoredCurrentness).toEqual(captured);
        expect(await restored.clearSessionDraftCurrentness({
            scope,
            address,
            currentness: restoredCurrentness!,
        })).toBe(true);
        restored.clearSessionDraftLaunchCurrentness({
            scope,
            address,
            userAttemptId: 'attempt-1',
        });

        expect(restored.getSessionDraftSnapshot(scope, address)).toMatchObject({
            materialized: true,
            document: { composer: { text: { value: 'newer edit after launch' } } },
            localSupplement: {},
        });
    });

    it('adopts a newer remote existing-session edit instead of conflicting with a captured clear', async () => {
        const cipher = plainCipher();
        const baseDocument = createSessionDocument('captured', uuid(300));
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, baseDocument),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: (() => {
                let next = 301;
                return () => uuid(next++);
            })(),
            now: () => 3,
        });
        await repository.materializeExact(scope, sessionAddress);
        const currentness = repository.captureSessionDraftCurrentness({
            scope,
            address: sessionAddress,
            fieldIds: ['composer.text'],
        });
        remote.replaceCurrent({
            revision: 2,
            content: await cipher.seal(sessionAddress, createSessionDocument('newer remote', uuid(310))),
            createdAt: 1,
            updatedAt: 2,
        });

        await repository.clearSessionDraftCurrentness({ scope, address: sessionAddress, currentness });

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'clean',
            conflict: null,
            materialized: true,
            document: { composer: { text: { value: 'newer remote' } } },
        });
        expect(vi.mocked(remote.transport.mutate)).toHaveBeenCalledTimes(1);
    });

    it('keeps a newer remote new-session edit visible when a captured launch clear races it', async () => {
        const cipher = plainCipher();
        const address = { kind: 'newSession', draftId: uuid(320) } as const;
        const remote = createRemote(undefined, address);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: (() => {
                let next = 321;
                return () => uuid(next++);
            })(),
            now: () => 3,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'captured', authoring: { machineId: 'machine-a' } },
            materializationIntent: 'userEdit',
        });
        await repository.flushSessionDraft({ scope, address });
        const currentness = repository.captureSessionDraftCurrentness({ scope, address });
        const newerRemote = structuredClone(repository.getSessionDraftSnapshot(scope, address)!.document);
        newerRemote.composer.text = { mutationId: uuid(330), value: 'newer remote' };
        remote.replaceCurrent({
            revision: 1,
            content: await cipher.seal(address, newerRemote),
            createdAt: 1,
            updatedAt: 2,
        });

        await repository.clearSessionDraftCurrentness({ scope, address, currentness });

        expect(repository.getSessionDraftSnapshot(scope, address)).toMatchObject({
            status: 'clean',
            conflict: null,
            materialized: true,
            document: { composer: { text: { value: 'newer remote' } } },
        });
        expect(repository.listNewSessionDraftProjections(scope)).toHaveLength(1);
        expect(remote.readCurrent()).toMatchObject({ revision: 2 });
    });

    it('keeps local recovery state when a remote envelope cannot be opened', async () => {
        const remote = createRemote({ revision: 2, content: { t: 'encrypted', c: 'wrong-key' }, createdAt: 1, updatedAt: 2 });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher: { seal: plainCipher().seal, open: vi.fn(async () => null) },
            randomUUID: () => uuid(40),
            now: () => 3,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'recover me' } });

        await expect(repository.materializeExact(scope, sessionAddress)).rejects.toThrow('Unable to open session draft');

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'error',
            document: { composer: { text: { value: 'recover me' } } },
        });
    });

    it('classifies a local sealing failure as error without attempting network transport', async () => {
        const transport: SessionDraftRepositoryTransport = {
            read: vi.fn(async () => ({ status: 'absent' as const })),
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            mutate: vi.fn(async () => { throw new Error('network should not run'); }),
        };
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher: {
                seal: vi.fn(async () => { throw new Error('local seal failed'); }),
                open: plainCipher().open,
            },
            randomUUID: () => uuid(340),
            now: () => 3,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'recover me' } });

        expect(await repository.flushSessionDraft({ scope, address: sessionAddress })).toEqual({ status: 'error' });
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)?.status).toBe('error');
        expect(transport.mutate).not.toHaveBeenCalled();
    });

    it('adopts equal remote values with newer mutation tokens without creating an empty conflict', async () => {
        const cipher = plainCipher();
        const localDocument = createSessionDocument('same', uuid(60));
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, localDocument),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(61),
            now: () => 2,
        });
        await repository.materializeExact(scope, sessionAddress);
        const equalRemoteWithNewTokens = createSessionDocument('same', uuid(62));
        remote.replaceCurrent({
            revision: 2,
            content: await cipher.seal(sessionAddress, equalRemoteWithNewTokens),
            createdAt: 1,
            updatedAt: 2,
        });

        await repository.materializeExact(scope, sessionAddress);

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'clean',
            conflict: null,
            document: { composer: { text: { mutationId: uuid(62), value: 'same' } } },
        });
    });

    it.each(['', '   '] as const)('converges when this device clears text to %j and the synced replica tombstones the draft', async (clearedText) => {
        const cipher = plainCipher();
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, createSessionDocument('clear me', uuid(63))),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(64),
            now: () => 2,
        });
        await repository.materializeExact(scope, sessionAddress);
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: clearedText } });
        remote.replaceCurrent({ revision: 2, content: null, createdAt: 1, updatedAt: 2 });

        await repository.flushSessionDraft({ scope, address: sessionAddress });

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toBeNull();
    });

    it('adopts a newer remote edit when the local replica has no pending mutations', async () => {
        const cipher = plainCipher();
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, createSessionDocument('first device', uuid(280))),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(281),
            now: () => 2,
        });
        await repository.materializeExact(scope, sessionAddress);
        remote.replaceCurrent({
            revision: 2,
            content: await cipher.seal(sessionAddress, createSessionDocument('continued elsewhere', uuid(282))),
            createdAt: 1,
            updatedAt: 2,
        });

        await repository.materializeExact(scope, sessionAddress);

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'clean',
            conflict: null,
            document: { composer: { text: { value: 'continued elsewhere' } } },
        });
    });

    it('ignores an out-of-order older exact read after adopting a newer revision', async () => {
        const cipher = plainCipher();
        const olderDocument = createSessionDocument('older', uuid(283));
        const newerDocument = createSessionDocument('newer', uuid(284));
        const remote = createRemote({
            revision: 2,
            content: await cipher.seal(sessionAddress, newerDocument),
            createdAt: 1,
            updatedAt: 2,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(285),
            now: () => 3,
        });
        await repository.materializeExact(scope, sessionAddress);
        remote.replaceCurrent({
            revision: 1,
            content: await cipher.seal(sessionAddress, olderDocument),
            createdAt: 1,
            updatedAt: 1,
        });

        await repository.materializeExact(scope, sessionAddress);

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'clean',
            conflict: null,
            document: { composer: { text: { value: 'newer' } } },
        });
    });

    it.each(['exact wake', 'snapshot hydration'] as const)('never exposes a conflict when %s observes this device own in-flight save', async (materializationPath) => {
        const cipher = plainCipher();
        let current = {
            revision: 1,
            content: await cipher.seal(sessionAddress, createSessionDocument('base', uuid(286))),
            createdAt: 1,
            updatedAt: 1,
        };
        const firstCommitted = createDeferred<void>();
        const firstMutationReleased = createDeferred<void>();
        let mutationCount = 0;
        const transport: SessionDraftRepositoryTransport = {
            read: vi.fn(async () => ({ status: 'present' as const, record: { address: sessionAddress, ...current } })),
            list: vi.fn(async () => ({ items: [{ address: sessionAddress, ...current }], nextAfter: undefined })),
            mutate: vi.fn(async ({ expectedRevision, content }) => {
                mutationCount += 1;
                expect(expectedRevision).toBe(current.revision);
                current = { ...current, revision: current.revision + 1, content, updatedAt: current.updatedAt + 1 };
                const record = { address: sessionAddress, ...current };
                if (mutationCount === 1) {
                    firstCommitted.resolve();
                    await firstMutationReleased.promise;
                }
                return { status: 'updated' as const, record };
            }),
        };
        const generated = [uuid(287), uuid(288), uuid(289), uuid(290), uuid(291), uuid(292)];
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => generated.shift() ?? uuid(293),
            now: () => 3,
        });
        await repository.materializeExact(scope, sessionAddress);
        const observedStatuses: string[] = [];
        repository.subscribeSessionDraft(scope, sessionAddress, () => {
            const status = repository.getSessionDraftSnapshot(scope, sessionAddress)?.status;
            if (status) observedStatuses.push(status);
        });

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'co' } });
        const flush = repository.flushSessionDraft({ scope, address: sessionAddress });
        await firstCommitted.promise;
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'continue' } });
        const materialize = materializationPath === 'exact wake'
            ? repository.materializeExact(scope, sessionAddress)
            : repository.ensureSessionDraftRepositoryHydrated(scope);
        await Promise.resolve();
        firstMutationReleased.resolve();
        await Promise.all([flush, materialize]);

        expect(observedStatuses).not.toContain('conflict');
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'clean',
            conflict: null,
            document: { composer: { text: { value: 'continue' } } },
        });
    });

    it.each([
        { failureBoundary: 'cipher', expectedStatus: 'error' },
        { failureBoundary: 'transport', expectedStatus: 'offline' },
    ] as const)('preserves newer local edits when an in-flight $failureBoundary operation fails', async ({ failureBoundary, expectedStatus }) => {
        const operationStarted = createDeferred<void>();
        const operationReleased = createDeferred<void>();
        const baseCipher = plainCipher();
        const cipher: SessionDraftRepositoryCipher = {
            open: baseCipher.open,
            seal: failureBoundary === 'cipher'
                ? vi.fn(async () => {
                    operationStarted.resolve();
                    await operationReleased.promise;
                    throw new Error('cipher unavailable');
                })
                : baseCipher.seal,
        };
        const transport: SessionDraftRepositoryTransport = {
            read: vi.fn(async () => ({ status: 'absent' as const })),
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            mutate: vi.fn(async () => {
                if (failureBoundary !== 'transport') throw new Error('transport must not run after cipher failure');
                operationStarted.resolve();
                await operationReleased.promise;
                throw new Error('server unavailable');
            }),
        };
        let nextUuid = 350;
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(nextUuid++),
            now: () => 3,
        });
        const observedTexts: string[] = [];
        repository.subscribeSessionDraft(scope, sessionAddress, () => {
            const text = repository.getSessionDraftSnapshot(scope, sessionAddress)?.document.composer.text.value;
            if (typeof text === 'string') observedTexts.push(text);
        });

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'h' } });
        const flush = repository.flushSessionDraft({ scope, address: sessionAddress });
        await operationStarted.promise;
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'hello world' } });
        operationReleased.resolve();

        expect(await flush).toEqual({ status: expectedStatus });
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: expectedStatus,
            conflict: null,
            document: { composer: { text: { value: 'hello world' } } },
        });
        expect(observedTexts.at(-1)).toBe('hello world');
    });

    it('rebases a newer pending edit onto its acknowledged field token before a later CAS conflict', async () => {
        const cipher = plainCipher();
        const baseDocument = createSessionDocument('base', uuid(294));
        let mutationCount = 0;
        let firstSubmittedDocument: SessionDraftDocumentV1 | null = null;
        const firstSubmitted = createDeferred<void>();
        const firstMutationReleased = createDeferred<void>();
        const transport: SessionDraftRepositoryTransport = {
            read: vi.fn(async () => ({
                status: 'present' as const,
                record: {
                    address: sessionAddress,
                    revision: 1,
                    content: await cipher.seal(sessionAddress, baseDocument),
                    createdAt: 1,
                    updatedAt: 1,
                },
            })),
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            mutate: vi.fn(async ({ content }) => {
                mutationCount += 1;
                if (mutationCount === 1) {
                    if (!content || content.t !== 'plain') throw new Error('expected plain submitted document');
                    firstSubmittedDocument = structuredClone(content.v.document);
                    firstSubmitted.resolve();
                    await firstMutationReleased.promise;
                    return {
                        status: 'updated' as const,
                        record: { address: sessionAddress, revision: 2, content, createdAt: 1, updatedAt: 2 },
                    };
                }
                if (!firstSubmittedDocument) throw new Error('first submitted document missing');
                const concurrentlyChanged = structuredClone(firstSubmittedDocument) as ExistingSessionDraftDocument;
                concurrentlyChanged.target.routing.recipient = { mutationId: uuid(295), value: { kind: 'user', userId: 'elsewhere' } };
                return {
                    status: 'conflict' as const,
                    current: {
                        address: sessionAddress,
                        revision: 3,
                        content: await cipher.seal(sessionAddress, concurrentlyChanged),
                        createdAt: 1,
                        updatedAt: 3,
                    },
                };
            }),
        };
        const generated = [uuid(296), uuid(297), uuid(298), uuid(299), uuid(300), uuid(301)];
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => generated.shift() ?? uuid(302),
            now: () => 4,
        });
        await repository.materializeExact(scope, sessionAddress);
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'co' } });
        const flush = repository.flushSessionDraft({ scope, address: sessionAddress });
        await firstSubmitted.promise;
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'continue' } });
        firstMutationReleased.resolve();

        expect(await flush).toEqual({ status: 'pending' });
        const snapshot = repository.getSessionDraftSnapshot(scope, sessionAddress)!;
        expect(snapshot.status).toBe('pending');
        expect(snapshot.conflict).toBeNull();
        expect(snapshot.document.composer.text.value).toBe('continue');
        if (snapshot.document.target.kind !== 'session') throw new Error('expected existing-session snapshot');
        expect(snapshot.document.target.routing.recipient.value).toEqual({ kind: 'user', userId: 'elsewhere' });
    });

    it('rebases a first-prefix CAS conflict from the latest local text typed while the request was in flight', async () => {
        const cipher = plainCipher();
        const firstPrefixSubmitted = createDeferred<void>();
        const firstConflictReleased = createDeferred<void>();
        const submittedTexts: string[] = [];
        let mutationCount = 0;
        const transport: SessionDraftRepositoryTransport = {
            read: vi.fn(async () => ({
                status: 'deleted' as const,
                record: { address: sessionAddress, revision: 1, content: null, createdAt: 1, updatedAt: 1 },
            })),
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            mutate: vi.fn(async ({ expectedRevision, content }) => {
                mutationCount += 1;
                if (!content || content.t !== 'plain') throw new Error('expected plain submitted document');
                submittedTexts.push(content.v.document.composer.text.value as string);
                if (mutationCount === 1) {
                    expect(expectedRevision).toBe('absent');
                    firstPrefixSubmitted.resolve();
                    await firstConflictReleased.promise;
                    return {
                        status: 'conflict' as const,
                        current: { address: sessionAddress, revision: 1, content: null, createdAt: 1, updatedAt: 1 },
                    };
                }
                expect(expectedRevision).toBe(1);
                return {
                    status: 'updated' as const,
                    record: { address: sessionAddress, revision: 2, content, createdAt: 1, updatedAt: 2 },
                };
            }),
        };
        const generated = [uuid(311), uuid(312), uuid(313), uuid(314), uuid(315), uuid(316)];
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => generated.shift() ?? uuid(317),
            now: () => 4,
        });

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 't' } });
        const flush = repository.flushSessionDraft({ scope, address: sessionAddress });
        await firstPrefixSubmitted.promise;
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'trace-switch' } });
        firstConflictReleased.resolve();

        expect(await flush).toEqual({ status: 'clean' });
        expect(submittedTexts).toEqual(['t', 'trace-switch']);
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'clean',
            conflict: null,
            document: { composer: { text: { value: 'trace-switch' } } },
        });
    });

    it('preserves text typed while an earlier empty-draft tombstone is in flight', async () => {
        const cipher = plainCipher();
        const baseDocument = createSessionDocument('base', uuid(303));
        const tombstoneSubmitted = createDeferred<void>();
        const tombstoneReleased = createDeferred<void>();
        let revision = 1;
        const transport: SessionDraftRepositoryTransport = {
            read: vi.fn(async () => ({
                status: 'present' as const,
                record: {
                    address: sessionAddress,
                    revision,
                    content: await cipher.seal(sessionAddress, baseDocument),
                    createdAt: 1,
                    updatedAt: 1,
                },
            })),
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            mutate: vi.fn(async ({ content }) => {
                revision += 1;
                if (content === null) {
                    tombstoneSubmitted.resolve();
                    await tombstoneReleased.promise;
                    return {
                        status: 'updated' as const,
                        record: { address: sessionAddress, revision, content: null, createdAt: 1, updatedAt: revision },
                    };
                }
                return {
                    status: 'updated' as const,
                    record: { address: sessionAddress, revision, content, createdAt: 1, updatedAt: revision },
                };
            }),
        };
        const generated = [uuid(304), uuid(305), uuid(306), uuid(307), uuid(308), uuid(309)];
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => generated.shift() ?? uuid(310),
            now: () => 4,
        });
        await repository.materializeExact(scope, sessionAddress);

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: '' } });
        const flush = repository.flushSessionDraft({ scope, address: sessionAddress });
        await tombstoneSubmitted.promise;
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'hello world' } });
        tombstoneReleased.resolve();

        expect(await flush).toEqual({ status: 'clean' });
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'clean',
            document: { composer: { text: { value: 'hello world' } } },
        });
        expect(transport.mutate).toHaveBeenCalledTimes(2);
    });

    it('reconciles a remotely tombstoned row missing from the active snapshot', async () => {
        const cipher = plainCipher();
        const document = createSessionDocument('delete remotely', uuid(70));
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, document),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(71),
            now: () => 2,
        });
        await repository.materializeExact(scope, sessionAddress);
        remote.replaceCurrent({ revision: 2, content: null, createdAt: 1, updatedAt: 2 });

        await repository.ensureSessionDraftRepositoryHydrated(scope);

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toBeNull();
    });

    it('removes a clean numeric-base replica when an exact read returns absent', async () => {
        const cipher = plainCipher();
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, createSessionDocument('base', uuid(260))),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(261),
            now: () => 2,
        });
        await repository.materializeExact(scope, sessionAddress);
        const writesBeforeAbsence = vi.mocked(remote.transport.mutate).mock.calls.length;
        vi.mocked(remote.transport.read).mockResolvedValue({ status: 'absent' });

        await repository.materializeExact(scope, sessionAddress);

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toBeNull();
        expect(vi.mocked(remote.transport.mutate)).toHaveBeenCalledTimes(writesBeforeAbsence);
    });

    it('preserves a numeric-base pending edit as an explicit conflict when an exact read returns absent', async () => {
        const cipher = plainCipher();
        const remote = createRemote({
            revision: 1,
            content: await cipher.seal(sessionAddress, createSessionDocument('base', uuid(270))),
            createdAt: 1,
            updatedAt: 1,
        });
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(271),
            now: () => 2,
        });
        await repository.materializeExact(scope, sessionAddress);
        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'recoverable' } });
        const writesBeforeAbsence = vi.mocked(remote.transport.mutate).mock.calls.length;
        vi.mocked(remote.transport.read).mockResolvedValue({ status: 'absent' });

        await repository.materializeExact(scope, sessionAddress);

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'conflict',
            document: { composer: { text: { value: 'recoverable' } } },
            conflict: { fields: [{ fieldId: 'composer.text', mine: 'recoverable', synced: null }] },
        });
        expect(vi.mocked(remote.transport.mutate)).toHaveBeenCalledTimes(writesBeforeAbsence);
    });

    it('publishes a hydrated remote snapshot atomically after every listed record is installed', async () => {
        const cipher = plainCipher();
        const otherAddress = { kind: 'session', sessionId: 'session-b' } as const;
        const firstDocument = createSessionDocument('first', uuid(230));
        const secondDocument = createSessionDocument('second', uuid(231));
        const transport: SessionDraftRepositoryTransport = {
            list: vi.fn(async () => ({
                items: [
                    { address: sessionAddress, revision: 1, content: await cipher.seal(sessionAddress, firstDocument), createdAt: 1, updatedAt: 1 },
                    { address: otherAddress, revision: 1, content: await cipher.seal(otherAddress, secondDocument), createdAt: 1, updatedAt: 1 },
                ],
                nextAfter: undefined,
            })),
            read: vi.fn(async () => ({ status: 'absent' as const })),
            mutate: vi.fn(async () => { throw new Error('not expected'); }),
        };
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher,
            randomUUID: () => uuid(232),
            now: () => 2,
        });
        const observedSnapshots: boolean[] = [];
        repository.subscribeSessionDraftList(scope, () => {
            observedSnapshots.push(
                repository.getSessionDraftSnapshot(scope, sessionAddress) !== null
                && repository.getSessionDraftSnapshot(scope, otherAddress) !== null,
            );
        });

        await repository.ensureSessionDraftRepositoryHydrated(scope);

        expect(observedSnapshots).toEqual([true]);
        expect(transport.read).not.toHaveBeenCalled();
    });

    it('hydrates openable records while preserving a listed draft whose session context is unavailable', async () => {
        const baseCipher = plainCipher();
        const unavailableAddress = { kind: 'session', sessionId: 'session-b' } as const;
        const laterAddress = { kind: 'newSession', draftId: uuid(235) } as const;
        const firstDocument = createSessionDocument('first', uuid(233));
        const unavailableDocument = createSessionDocument('unavailable', uuid(234));
        const laterDocument = createNewSessionDocument('later', uuid(236));
        const records = await Promise.all([
            { address: sessionAddress, document: firstDocument },
            { address: unavailableAddress, document: unavailableDocument },
            { address: laterAddress, document: laterDocument },
        ].map(async ({ address, document }) => ({
            address,
            revision: 1,
            content: await baseCipher.seal(address, document),
            createdAt: 1,
            updatedAt: 1,
        })));
        const transport: SessionDraftRepositoryTransport = {
            list: vi.fn(async () => ({ items: records, nextAfter: undefined })),
            read: vi.fn(async () => ({ status: 'absent' as const })),
            mutate: vi.fn(async () => { throw new Error('not expected'); }),
        };
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher: {
                seal: baseCipher.seal,
                open: vi.fn(async (address, content) => {
                    if (address.kind === 'session' && address.sessionId === unavailableAddress.sessionId) {
                        throw new SessionDraftContextUnavailableError();
                    }
                    return baseCipher.open(address, content);
                }),
            },
            randomUUID: () => uuid(237),
            now: () => 2,
        });
        repository.writeExistingSessionDraft({
            scope,
            sessionId: unavailableAddress.sessionId,
            patch: { text: 'preserve locally' },
        });

        await repository.ensureSessionDraftRepositoryHydrated(scope);

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)?.document).toEqual(firstDocument);
        expect(repository.getSessionDraftSnapshot(scope, laterAddress)?.document).toEqual(laterDocument);
        expect(repository.listNewSessionDraftProjections(scope).map((draft) => draft.draftId)).toEqual([
            laterAddress.draftId,
        ]);
        expect(repository.getSessionDraftSnapshot(scope, unavailableAddress)).toMatchObject({
            document: { composer: { text: { value: 'preserve locally' } } },
        });
        expect(transport.read).not.toHaveBeenCalled();
    });

    it('preserves a locally known draft when exact-read hydration cannot load its session context', async () => {
        const baseCipher = plainCipher();
        const remoteDocument = createSessionDocument('remote', uuid(238));
        const remoteRecord = {
            address: sessionAddress,
            revision: 2,
            content: await baseCipher.seal(sessionAddress, remoteDocument),
            createdAt: 1,
            updatedAt: 2,
        };
        const transport: SessionDraftRepositoryTransport = {
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            read: vi.fn(async () => ({ status: 'present' as const, record: remoteRecord })),
            mutate: vi.fn(),
        };
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher: {
                seal: baseCipher.seal,
                open: vi.fn(async () => {
                    throw new SessionDraftContextUnavailableError();
                }),
            },
            randomUUID: () => uuid(239),
            now: () => 3,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: sessionAddress.sessionId, patch: { text: 'local' } });

        await repository.ensureSessionDraftRepositoryHydrated(scope);

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            document: { composer: { text: { value: 'local' } } },
        });
        expect(transport.read).toHaveBeenCalledWith(sessionAddress);
    });

    it('does not silently classify invalid new-session content as unavailable session context', async () => {
        const address = { kind: 'newSession', draftId: uuid(238) } as const;
        const document = createNewSessionDocument('invalid', uuid(239));
        const cipher = plainCipher();
        const transport: SessionDraftRepositoryTransport = {
            list: vi.fn(async () => ({
                items: [{
                    address,
                    revision: 1,
                    content: await cipher.seal(address, document),
                    createdAt: 1,
                    updatedAt: 1,
                }],
                nextAfter: undefined,
            })),
            read: vi.fn(async () => ({ status: 'absent' as const })),
            mutate: vi.fn(async () => { throw new Error('not expected'); }),
        };
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport,
            syncEnabled: true,
            cipher: {
                seal: cipher.seal,
                open: vi.fn(async () => null),
            },
        });

        await expect(repository.ensureSessionDraftRepositoryHydrated(scope))
            .rejects.toThrow(`Unable to open session draft new-session/${address.draftId}`);
        expect(repository.listNewSessionDraftProjections(scope)).toEqual([]);
    });

    it('does not redirect a pending flush through a transport configured for another account', async () => {
        const sealStarted = createDeferred<void>();
        const releaseSeal = createDeferred<void>();
        const baseCipher = plainCipher();
        const firstTransport = createRemote().transport;
        const secondTransport = createRemote().transport;
        const secondScope = { serverId: 'server-a', accountId: 'account-b' } as const;
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: firstTransport,
            syncEnabled: true,
            cipher: {
                open: baseCipher.open,
                seal: vi.fn(async (address, document) => {
                    sealStarted.resolve();
                    await releaseSeal.promise;
                    return baseCipher.seal(address, document);
                }),
            },
            randomUUID: () => uuid(240),
            now: () => 2,
        });
        repository.writeExistingSessionDraft({ scope, sessionId: sessionAddress.sessionId, patch: { text: 'account A' } });

        const flush = repository.flushSessionDraft({ scope, address: sessionAddress });
        await sealStarted.promise;
        repository.configure({
            scope: secondScope,
            transport: secondTransport,
            cipher: baseCipher,
            syncEnabled: true,
        });
        releaseSeal.resolve();

        await expect(flush).resolves.toEqual({ status: 'pending' });
        expect(firstTransport.mutate).not.toHaveBeenCalled();
        expect(secondTransport.mutate).not.toHaveBeenCalled();
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)).toMatchObject({
            status: 'pending',
            document: { composer: { text: { value: 'account A' } } },
        });
    });

    it('does not apply a staged snapshot after the repository is configured for another account', async () => {
        const listStarted = createDeferred<void>();
        const releaseList = createDeferred<void>();
        const address = { kind: 'newSession', draftId: uuid(241) } as const;
        const document = createNewSessionDocument('account A remote', uuid(242));
        const cipher = plainCipher();
        const firstTransport: SessionDraftRepositoryTransport = {
            list: vi.fn(async () => {
                listStarted.resolve();
                await releaseList.promise;
                return {
                    items: [{
                        address,
                        revision: 1,
                        content: await cipher.seal(address, document),
                        createdAt: 1,
                        updatedAt: 1,
                    }],
                    nextAfter: undefined,
                };
            }),
            read: vi.fn(async () => ({ status: 'absent' as const })),
            mutate: vi.fn(async () => { throw new Error('not expected'); }),
        };
        const secondTransport = createRemote().transport;
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            scope,
            transport: firstTransport,
            syncEnabled: true,
            cipher,
        });

        const hydration = repository.ensureSessionDraftRepositoryHydrated(scope);
        await listStarted.promise;
        repository.configure({
            scope: { serverId: 'server-a', accountId: 'account-b' },
            transport: secondTransport,
            syncEnabled: true,
            cipher,
        });
        releaseList.resolve();
        await hydration;

        expect(repository.getSessionDraftSnapshot(scope, address)).toBeNull();
        expect(secondTransport.read).not.toHaveBeenCalled();
        expect(secondTransport.list).not.toHaveBeenCalled();
        expect(secondTransport.mutate).not.toHaveBeenCalled();
    });

    it('keeps an immediate local edit durable when a later snapshot page fails', async () => {
        const storage = createMemoryStorage();
        let resolveFirstPage: ((value: { items: []; nextAfter: string }) => void) | undefined;
        const transport: SessionDraftRepositoryTransport = {
            list: vi.fn()
                .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstPage = resolve; }))
                .mockRejectedValueOnce(new Error('later page failed')),
            read: vi.fn(async () => ({ status: 'absent' as const })),
            mutate: vi.fn(async () => { throw new Error('not expected'); }),
        };
        const repository = createSessionDraftRepository({
            storage,
            transport,
            syncEnabled: true,
            cipher: plainCipher(),
            randomUUID: () => uuid(280),
            now: () => 2,
        });
        const hydration = repository.ensureSessionDraftRepositoryHydrated(scope);

        repository.writeExistingSessionDraft({ scope, sessionId: 'session-a', patch: { text: 'typed while loading' } });
        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)?.document.composer.text.value).toBe('typed while loading');
        resolveFirstPage?.({ items: [], nextAfter: 'next' });
        await expect(hydration).rejects.toThrow('later page failed');

        expect(repository.getSessionDraftSnapshot(scope, sessionAddress)?.document.composer.text.value).toBe('typed while loading');
        const restored = createSessionDraftRepository({
            storage,
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(281),
            now: () => 3,
        });
        expect(restored.getSessionDraftSnapshot(scope, sessionAddress)?.document.composer.text.value).toBe('typed while loading');
    });

    it('censuses only numeric-base new-session records and atomically acknowledges migrated base bytes', async () => {
        const cipher = plainCipher();
        const address = { kind: 'newSession', draftId: uuid(290) } as const;
        const remote = createRemote(undefined, address);
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            transport: remote.transport,
            syncEnabled: true,
            cipher,
            randomUUID: (() => {
                let next = 291;
                return () => uuid(next++);
            })(),
            now: () => 2,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'server base' },
            materializationIntent: 'userEdit',
        });
        await repository.flushSessionDraft({ scope, address });
        repository.writeNewSessionDraft({
            scope,
            draftId: address.draftId,
            patch: { text: 'pending local edit' },
            materializationIntent: 'userEdit',
        });
        expect(repository.listNewSessionDraftEncryptionMigrationCandidates(scope)).toMatchObject([{
            address,
            baseRevision: 0,
            document: { composer: { text: { value: 'server base' } } },
        }]);
        const migratedBase = repository.listNewSessionDraftEncryptionMigrationCandidates(scope)[0]!.document;

        await repository.acknowledgeNewSessionDraftEncryptionMigration(scope, [{
            address,
            revision: 1,
            content: await cipher.seal(address, migratedBase),
            createdAt: 1,
            updatedAt: 3,
        }]);

        expect(repository.listNewSessionDraftEncryptionMigrationCandidates(scope)).toMatchObject([{
            address,
            baseRevision: 1,
            document: { composer: { text: { value: 'server base' } } },
        }]);
        expect(repository.getSessionDraftSnapshot(scope, address)).toMatchObject({
            status: 'pending',
            document: { composer: { text: { value: 'pending local edit' } } },
        });
    });

    it('returns referentially stable snapshots and list projections until the replica changes', () => {
        const repository = createSessionDraftRepository({
            storage: createMemoryStorage(),
            syncEnabled: false,
            cipher: plainCipher(),
            randomUUID: () => uuid(80),
            now: () => 1,
        });
        repository.writeNewSessionDraft({
            scope,
            draftId: '00000000-0000-4000-8000-000000000099',
            patch: { text: 'stable' },
            materializationIntent: 'userEdit',
        });
        const address = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000099' } as const;

        expect(repository.getSessionDraftSnapshot(scope, address)).toBe(repository.getSessionDraftSnapshot(scope, address));
        expect(repository.listNewSessionDraftProjections(scope)).toBe(repository.listNewSessionDraftProjections(scope));

        const before = repository.getSessionDraftSnapshot(scope, address);
        repository.writeSessionDraftLocalSupplement({ scope, address, patch: { launchUserAttemptId: 'attempt-1' } });
        expect(repository.getSessionDraftSnapshot(scope, address)).not.toBe(before);
    });
});

function createSessionDocument(text: string, mutationId: string): ExistingSessionDraftDocument {
    return {
        v: 1 as const,
        composer: {
            text: { mutationId, value: text },
            mentions: { mutationId: uuid(50), value: [] },
            attachments: { mutationId: uuid(51), value: [] },
        },
        target: { kind: 'session' as const, routing: {
            recipient: { mutationId: uuid(52), value: null },
            agentContinuation: { mutationId: uuid(53), value: null },
            executionRunDelivery: { mutationId: uuid(54), value: null },
        } },
        extensions: {},
    };
}

function createNewSessionDocument(text: string, mutationId: string): NewSessionDraftDocument {
    return {
        v: 1 as const,
        composer: {
            text: { mutationId, value: text },
            mentions: { mutationId: uuid(55), value: [] },
            attachments: { mutationId: uuid(56), value: [] },
        },
        target: { kind: 'newSession' as const, authoring: {} },
        extensions: {},
    };
}

function assertNewSessionDocument(document: SessionDraftDocumentV1): asserts document is NewSessionDraftDocument {
    if (document.target.kind !== 'newSession') throw new Error('expected new-session fixture');
}
