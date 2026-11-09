import { describe, expect, it, vi } from 'vitest';
import type { SessionDraftAddressV2, SessionDraftDocumentV2, SessionDraftRecordV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import type { ChangeEntry } from '@happier-dev/protocol/changes';
import { canonicalSessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import {
    createSessionDraftRepository,
    type SessionDraftRepositoryTransport,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionDraftContextUnavailableError } from '@/sync/ops/sessionDrafts/sessionDraftCipherError';
import { applyPlannedChangeActions } from './changesApplier';
import { runSocketReconnectCatchUpViaChanges } from './socketReconnectViaChanges';

import {
    SessionDraftRuntimeHydrationGate,
    materializeVisibleExistingSessionDraft,
    materializeSessionDraftSocketWake,
    parseSessionDraftSocketWake,
} from './sessionDraftSyncRuntime';

const SCOPE: ServerAccountScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });

describe('sessionDraftSyncRuntime', () => {
    it('replays reconnect pages for 50 held drafts without reads and materializes one advancing revision once', async () => {
        const cipher = createSessionDraftCipher({
            accountMode: 'plain', accountCryptoMaterial: null,
            getSessionContext: () => ({ mode: 'plain' }),
            randomBytes: length => new Uint8Array(length),
        });
        const records = new Map<string, SessionDraftRecordV2>();
        for (let index = 0; index < 50; index += 1) {
            const address = { kind: 'session' as const, sessionId: `session-${index}` };
            records.set(canonicalSessionDraftAddressV2(address), {
                address, revision: 2, content: await cipher.seal(address, sessionDocument(`held ${index}`, index + 1)),
                createdAt: 1, updatedAt: 2,
            });
        }
        const read = vi.fn<SessionDraftRepositoryTransport['read']>(async address => {
            const record = records.get(canonicalSessionDraftAddressV2(address));
            if (!record) return { status: 'absent' };
            return record.content === null ? { status: 'deleted', record } : { status: 'present', record };
        });
        const values = new Map<string, string>();
        const repository = createSessionDraftRepository({
            storage: { getString: key => values.get(key), getAllKeys: () => [...values.keys()], set: (key, value) => values.set(key, value), delete: key => values.delete(key) },
            cipher, syncEnabled: true,
            transport: { read, list: async () => ({ items: [], nextAfter: undefined }), mutate: async () => { throw new Error('unexpected mutation'); } },
        });
        for (const record of records.values()) await repository.materializeExact(SCOPE, record.address);
        read.mockClear();
        const changes: ChangeEntry[] = [...records.values()].map((record, index) => ({
            cursor: index + 1, kind: 'account', changedAt: 2,
            entityId: `session-draft:${canonicalSessionDraftAddressV2(record.address)}`,
            hint: { v: 1, sessionDraft: true, address: record.address, revision: record.revision, status: 'present' },
        }));
        // A prior unrelated partial materialization can keep the durable cursor behind
        // already applied drafts; the server may return those entries on every resume.
        const applyPlanned = (planned: Parameters<typeof applyPlannedChangeActions>[0]['planned']) => applyPlannedChangeActions({
            planned, credentials: { token: 't', secret: 's' }, isSessionMessagesLoaded: () => false,
            invalidate: {}, invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
            applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }),
            materializeSessionDraft: (address, revision) => repository.materializeExact(SCOPE, address, revision),
        });
        const catchUp = (page: ChangeEntry[]) => runSocketReconnectCatchUpViaChanges({
            credentials: { token: 't', secret: 's' }, accountId: SCOPE.accountId,
            afterCursor: '0', changesPageLimit: 50,
            fetchChanges: async ({ afterCursor }) => {
                const changes = page.filter(change => change.cursor > Number(afterCursor)).slice(0, 50);
                return { status: 'ok', changes, nextCursor: String(changes.at(-1)?.cursor ?? afterCursor) };
            },
            snapshotRefresh: async () => { throw new Error('unexpected snapshot'); },
            applyPlanned,
        });
        for (let reconnect = 0; reconnect < 6; reconnect += 1) {
            expect(await catchUp(changes)).toMatchObject({ status: 'ok', nextCursor: '50' });
        }
        expect(read).toHaveBeenCalledTimes(0);

        // Reproduce A..E re-walks without losing a single successful checkpoint:
        // an unsupported earlier entry prevents durable progress, while later
        // pages still materialize through their real owners.
        const retainedHistory: ChangeEntry[] = [
            { cursor: 1, kind: 'future-kind', entityId: 'blocked', changedAt: 1 },
            ...changes.map(change => ({ ...change, cursor: change.cursor + 1 })),
        ];
        let retainedCursor = '0';
        const requestedCursors: string[] = [];
        const blockedCursors: string[] = [];
        const walkHistory = () => runSocketReconnectCatchUpViaChanges({
            credentials: { token: 't', secret: 's' }, accountId: SCOPE.accountId,
            afterCursor: retainedCursor, changesPageLimit: 10,
            fetchChanges: async ({ afterCursor }) => {
                requestedCursors.push(String(afterCursor));
                const page = retainedHistory.filter(change => change.cursor > Number(afterCursor)).slice(0, 10);
                return { status: 'ok', changes: page, nextCursor: String(page.at(-1)?.cursor ?? afterCursor) };
            },
            fetchCurrentCursor: async () => ({ status: 'ok', cursor: '51' }),
            checkpointCursor: cursor => { retainedCursor = cursor; return true; },
            onCursorBlocked: context => blockedCursors.push(context.blockedCursor),
            snapshotRefresh: async () => ({ status: 'complete' }),
            applyPlanned,
        });
        for (let wake = 0; wake < 3; wake += 1) {
            expect(await walkHistory()).toMatchObject({ status: 'ok', nextCursor: '0' });
        }
        expect(requestedCursors).toEqual(Array.from({ length: 3 }, () => ['0', '10', '20', '30', '40', '50']).flat());
        expect(blockedCursors).toEqual(['1', '1', '1']);
        expect(retainedCursor).toBe('0');
        expect(read).toHaveBeenCalledTimes(0);
        // Once the earlier failure is resolved, every page checkpoints and the
        // next wake starts at the completed cursor rather than re-walking A..E.
        retainedHistory.shift();
        expect(await walkHistory()).toMatchObject({ status: 'ok', nextCursor: '51' });
        expect(retainedCursor).toBe('51');
        requestedCursors.length = 0;
        expect(await walkHistory()).toMatchObject({ status: 'ok', nextCursor: '51' });
        expect(requestedCursors).toEqual(['51']);
        expect(read).toHaveBeenCalledTimes(0);

        const changed = [...records.values()][17]!;
        records.set(canonicalSessionDraftAddressV2(changed.address), {
            ...changed, revision: 4, updatedAt: 4,
            content: await cipher.seal(changed.address, sessionDocument('advanced remote content', 100)),
        });
        // The highest revision wins even if repeated entries arrive out of revision order.
        const advanced: ChangeEntry[] = [4, 3].map((revision, index) => ({
            cursor: 51 + index, kind: 'account', changedAt: 4,
            entityId: `session-draft:${canonicalSessionDraftAddressV2(changed.address)}`,
            hint: { v: 1, sessionDraft: true, address: changed.address, revision, status: 'present' },
        }));
        const changedPage = changes.map(change => change.cursor === 18 ? { ...change, hint: advanced[0]!.hint } : change);
        expect(await catchUp([...changedPage, ...advanced])).toMatchObject({ status: 'ok', nextCursor: '52' });
        expect(read).toHaveBeenCalledTimes(1);
        expect(repository.getSessionComposerDraftSnapshot(SCOPE, changed.address)?.composer.text.value).toBe('advanced remote content');
        for (const change of advanced) {
            expect(await catchUp([change])).toMatchObject({ status: 'ok', nextCursor: String(change.cursor) });
        }
        expect(read).toHaveBeenCalledTimes(1);

        // The live push uses the same revision-aware materialization owner.
        expect(await materializeSessionDraftSocketWake({
            payload: { type: 'session-draft-updated', ...advanced[0]!.hint as object },
            capturedScope: SCOPE, readActiveScope: () => SCOPE,
            materializeExact: (scope, address, revision) => repository.materializeExact(scope, address, revision),
        })).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);

        records.set(canonicalSessionDraftAddressV2(changed.address), { ...changed, revision: 5, content: null, updatedAt: 5 });
        const deleted: ChangeEntry = { ...advanced[0]!, cursor: 53, changedAt: 5,
            hint: { v: 1, sessionDraft: true, address: changed.address, revision: 5, status: 'deleted' } };
        expect(await catchUp([deleted])).toMatchObject({ status: 'ok', nextCursor: '53' });
        expect(read).toHaveBeenCalledTimes(2);
        expect(repository.getSessionComposerDraftSnapshot(SCOPE, changed.address)).toBeNull();
        await catchUp([...advanced, deleted]);
        expect(read).toHaveBeenCalledTimes(2);

        records.set(canonicalSessionDraftAddressV2(changed.address), { ...changed, revision: 6, updatedAt: 6,
            content: await cipher.seal(changed.address, sessionDocument('recreated by live push', 101)) });
        const recreated: ChangeEntry = { ...deleted, cursor: 54, changedAt: 6,
            hint: { v: 1, sessionDraft: true, address: changed.address, revision: 6, status: 'present' } };
        read.mockRejectedValueOnce(new Error('offline'));
        expect(await catchUp([recreated])).toMatchObject({ status: 'ok', nextCursor: '0' });
        expect(repository.getSessionComposerDraftSnapshot(SCOPE, changed.address)).toBeNull();
        expect(await materializeSessionDraftSocketWake({
            payload: { type: 'session-draft-updated', ...recreated.hint as object },
            capturedScope: SCOPE, readActiveScope: () => SCOPE,
            materializeExact: repository.materializeExact.bind(repository),
        })).toBe(true);
        expect(read).toHaveBeenCalledTimes(4);
        expect(repository.getSessionComposerDraftSnapshot(SCOPE, changed.address)?.composer.text.value).toBe('recreated by live push');
        await catchUp([recreated]);
        expect(read).toHaveBeenCalledTimes(4);
    });

    it('retries a failed first hydration on the next ordinary resume', async () => {
        const gate = new SessionDraftRuntimeHydrationGate();
        const hydrate = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(true);

        await expect(gate.run({ scope: SCOPE, force: false, hydrate })).rejects.toThrow('offline');
        await expect(gate.run({ scope: SCOPE, force: false, hydrate })).resolves.toBeUndefined();
        expect(hydrate).toHaveBeenCalledTimes(2);
    });

    it('skips an already-hydrated ordinary resume but forces reconnect reconciliation', async () => {
        const gate = new SessionDraftRuntimeHydrationGate();
        const hydrate = vi.fn(async () => true);

        await gate.run({ scope: SCOPE, force: false, hydrate });
        await gate.run({ scope: SCOPE, force: false, hydrate });
        expect(hydrate).toHaveBeenCalledTimes(1);

        await gate.run({ scope: SCOPE, force: true, hydrate });
        expect(hydrate).toHaveBeenCalledTimes(2);
    });

    it('does not let a delayed hydration from a reset scope mark either scope ready', async () => {
        const gate = new SessionDraftRuntimeHydrationGate();
        let resolveOld!: (value: boolean) => void;
        const oldHydration = new Promise<boolean>((resolve) => {
            resolveOld = resolve;
        });
        const hydrateOld = vi.fn(() => oldHydration);
        const oldRun = gate.run({ scope: SCOPE, force: false, hydrate: hydrateOld });

        gate.reset();
        const nextScope = { serverId: 'server-b', accountId: 'account-b' } as const;
        const hydrateNext = vi.fn(async () => true);
        await gate.run({ scope: nextScope, force: false, hydrate: hydrateNext });
        resolveOld(true);
        await oldRun;

        const retryOld = vi.fn(async () => true);
        await gate.run({ scope: SCOPE, force: false, hydrate: retryOld });
        expect(retryOld).toHaveBeenCalledTimes(1);
    });

    it('parses only the content-free draft wake contract', () => {
        expect(parseSessionDraftSocketWake({
            type: 'session-draft-updated',
            v: 1,
            sessionDraft: true,
            address: { kind: 'session', sessionId: 'session-a' },
            revision: 4,
            status: 'present',
        })).toEqual({
            v: 1,
            sessionDraft: true,
            address: { kind: 'session', sessionId: 'session-a' },
            revision: 4,
            status: 'present',
        });

        expect(parseSessionDraftSocketWake({
            type: 'session-draft-updated',
            address: { kind: 'session', sessionId: 'session-a' },
        })).toBeNull();
        expect(parseSessionDraftSocketWake({ type: 'machine-activity' })).toBeNull();
    });

    it('accepts successor newSession wakes only on their V2 event and rejects content-bearing hints', () => {
        const hint = {
            v: 2, sessionDraftV2: true,
            address: { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000010' },
            revision: 4, status: 'present',
        };
        expect(parseSessionDraftSocketWake({ type: 'session-draft-v2-updated', ...hint })).toEqual(hint);
        expect(parseSessionDraftSocketWake({ type: 'session-draft-updated', ...hint })).toBeNull();
        expect(parseSessionDraftSocketWake({ type: 'session-draft-v2-updated', ...hint, content: 'private' })).toBeNull();
    });

    it('exact-materializes only while the captured server/account scope remains active', async () => {
        const materializeExact = vi.fn(async (
            _scope: ServerAccountScope,
            _address: SessionDraftAddressV2,
        ) => undefined);
        let activeScope: ServerAccountScope | null = SCOPE;
        const payload = {
            type: 'session-draft-updated',
            v: 1,
            sessionDraft: true,
            address: { kind: 'newSession' as const, draftId: '018f47ac-7f52-7aa4-8f25-8f17149101a0' },
            revision: 2,
            status: 'deleted' as const,
        };

        await expect(materializeSessionDraftSocketWake({
            payload,
            capturedScope: SCOPE,
            readActiveScope: () => activeScope,
            materializeExact,
        })).resolves.toBe(true);
        expect(materializeExact).toHaveBeenCalledWith(SCOPE, payload.address, payload.revision);

        materializeExact.mockClear();
        activeScope = { serverId: 'server-b', accountId: 'account-a' };
        await expect(materializeSessionDraftSocketWake({
            payload,
            capturedScope: SCOPE,
            readActiveScope: () => activeScope,
            materializeExact,
        })).resolves.toBe(false);
        expect(materializeExact).not.toHaveBeenCalled();
    });

    it('rejects a scope switch that happens during exact materialization', async () => {
        let activeScope: ServerAccountScope | null = SCOPE;
        const materializeExact = vi.fn(async () => {
            activeScope = { serverId: 'server-a', accountId: 'account-b' };
        });

        await expect(materializeSessionDraftSocketWake({
            payload: {
                type: 'session-draft-updated',
                v: 1,
                sessionDraft: true,
                address: { kind: 'session', sessionId: 'session-a' },
                revision: 5,
                status: 'present',
            },
            capturedScope: SCOPE,
            readActiveScope: () => activeScope,
            materializeExact,
        })).resolves.toBe(false);
    });

    it('defers unavailable socket context without hiding foreground or transport failures, then recovers', async () => {
        const payload = {
            type: 'session-draft-updated',
            v: 1,
            sessionDraft: true,
            address: { kind: 'session' as const, sessionId: 'session-a' },
            revision: 5,
            status: 'present' as const,
        };
        let contextAvailable = true;
        const cipher = createSessionDraftCipher({
            accountMode: 'plain',
            accountCryptoMaterial: null,
            getSessionContext: () => contextAvailable ? { mode: 'plain' as const } : null,
            randomBytes: (length) => new Uint8Array(length),
        });
        let record = {
            address: payload.address,
            revision: 1,
            content: await cipher.seal(payload.address, sessionDocument('first remote', 1)),
            createdAt: 1,
            updatedAt: 1,
        };
        let transportFailure: Error | null = null;
        const transport: SessionDraftRepositoryTransport = {
            read: vi.fn(async () => {
                if (transportFailure) throw transportFailure;
                return { status: 'present' as const, record };
            }),
            list: vi.fn(async () => ({ items: [], nextAfter: undefined })),
            mutate: vi.fn(async () => { throw new Error('not expected'); }),
        };
        const values = new Map<string, string>();
        const repository = createSessionDraftRepository({
            storage: {
                getString: (key) => values.get(key), getAllKeys: () => [...values.keys()],
                set: (key, value) => values.set(key, value),
                delete: (key) => values.delete(key),
            },
            transport,
            syncEnabled: true,
            cipher,
        });
        await repository.materializeExact(SCOPE, payload.address);
        record = {
            ...record,
            revision: 2,
            content: await cipher.seal(payload.address, sessionDocument('second remote', 2)),
            updatedAt: 2,
        };
        contextAvailable = false;

        await expect(materializeVisibleExistingSessionDraft({
            sessionId: payload.address.sessionId,
            capturedScope: SCOPE,
            isCurrent: () => true,
            materializeExact: (scope, address) => repository.materializeExact(scope, address),
        })).rejects.toBeInstanceOf(SessionDraftContextUnavailableError);
        expect(repository.getSessionDraftSnapshot(SCOPE, payload.address)).toMatchObject({
            status: 'clean',
            document: { composer: { text: { value: 'first remote' } } },
        });
        await expect(materializeSessionDraftSocketWake({
            payload,
            capturedScope: SCOPE,
            readActiveScope: () => SCOPE,
            materializeExact: (scope, address) => repository.materializeExact(scope, address),
        })).resolves.toBe(false);

        contextAvailable = true;
        transportFailure = new Error('network unavailable');
        await expect(materializeSessionDraftSocketWake({
            payload,
            capturedScope: SCOPE,
            readActiveScope: () => SCOPE,
            materializeExact: (scope, address) => repository.materializeExact(scope, address),
        })).rejects.toThrow('network unavailable');

        transportFailure = null;
        await expect(materializeVisibleExistingSessionDraft({
            sessionId: payload.address.sessionId,
            capturedScope: SCOPE,
            isCurrent: () => true,
            materializeExact: (scope, address) => repository.materializeExact(scope, address),
        })).resolves.toBe(true);
        expect(repository.getSessionDraftSnapshot(SCOPE, payload.address)).toMatchObject({
            status: 'clean',
            document: { composer: { text: { value: 'second remote' } } },
        });
    });

    it('refreshes the visible existing-session draft after repository runtime hydration', async () => {
        const materializeExact = vi.fn(async (
            _scope: ServerAccountScope,
            _address: SessionDraftAddressV2,
        ) => undefined);

        await expect(materializeVisibleExistingSessionDraft({
            sessionId: 'session-a',
            capturedScope: SCOPE,
            isCurrent: () => true,
            materializeExact,
        })).resolves.toBe(true);

        expect(materializeExact).toHaveBeenCalledWith(SCOPE, {
            kind: 'session',
            sessionId: 'session-a',
        });
    });

    it('materializes the exact routed scope while another Home remains active', async () => {
        const routedScope = { serverId: 'server-b', accountId: 'account-b' } as const;
        const materializeExact = vi.fn(async () => undefined);

        await expect(materializeVisibleExistingSessionDraft({
            sessionId: 'shared-session-id',
            capturedScope: routedScope,
            isCurrent: () => true,
            materializeExact,
        })).resolves.toBe(true);

        expect(materializeExact).toHaveBeenCalledWith(routedScope, {
            kind: 'session',
            sessionId: 'shared-session-id',
        });
    });

    it('does not refresh a visible draft after its server/account scope changes', async () => {
        let current = true;
        const materializeExact = vi.fn(async (
            _scope: ServerAccountScope,
            _address: SessionDraftAddressV2,
        ) => undefined);

        await expect(materializeVisibleExistingSessionDraft({
            sessionId: 'session-a',
            capturedScope: SCOPE,
            isCurrent: () => current,
            materializeExact: async (...args) => {
                current = false;
                await materializeExact(...args);
            },
        })).resolves.toBe(false);

        expect(materializeExact).toHaveBeenCalledOnce();
    });
});

function sessionDocument(text: string, mutation: number): SessionDraftDocumentV2 {
    const id = (offset: number) => `00000000-0000-4000-8000-${String(mutation * 10 + offset).padStart(12, '0')}`;
    return {
        v: 1,
        composer: {
            text: { mutationId: id(1), value: text },
            mentions: { mutationId: id(2), value: [] },
            attachments: { mutationId: id(3), value: [] },
        },
        target: { kind: 'session', routing: {
            recipient: { mutationId: id(4), value: null },
            agentContinuation: { mutationId: id(5), value: null },
            executionRunDelivery: { mutationId: id(6), value: null },
        } },
        extensions: {},
    };
}
