import { describe, expect, it, vi } from 'vitest';
import type { SessionDraftDocumentV1 } from '@happier-dev/protocol';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import {
    createSessionDraftRepository,
    type SessionDraftRepositoryTransport,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionDraftContextUnavailableError } from '@/sync/ops/sessionDrafts/sessionDraftCipherError';

import {
    SessionDraftRuntimeHydrationGate,
    materializeVisibleExistingSessionDraft,
    materializeSessionDraftSocketWake,
    parseSessionDraftSocketWake,
} from './sessionDraftSyncRuntime';

const SCOPE: ServerAccountScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });

describe('sessionDraftSyncRuntime', () => {
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

    it('exact-materializes only while the captured server/account scope remains active', async () => {
        const materializeExact = vi.fn(async () => undefined);
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
        expect(materializeExact).toHaveBeenCalledWith(SCOPE, payload.address);

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
                getString: (key) => values.get(key),
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
            readActiveScope: () => SCOPE,
            ensureRuntimeReady: async () => undefined,
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
            readActiveScope: () => SCOPE,
            ensureRuntimeReady: async () => undefined,
            materializeExact: (scope, address) => repository.materializeExact(scope, address),
        })).resolves.toBe(true);
        expect(repository.getSessionDraftSnapshot(SCOPE, payload.address)).toMatchObject({
            status: 'clean',
            document: { composer: { text: { value: 'second remote' } } },
        });
    });

    it('refreshes the visible existing-session draft after repository runtime hydration', async () => {
        const ensureRuntimeReady = vi.fn(async () => undefined);
        const materializeExact = vi.fn(async () => undefined);

        await expect(materializeVisibleExistingSessionDraft({
            sessionId: 'session-a',
            capturedScope: SCOPE,
            readActiveScope: () => SCOPE,
            ensureRuntimeReady,
            materializeExact,
        })).resolves.toBe(true);

        expect(ensureRuntimeReady).toHaveBeenCalledOnce();
        expect(materializeExact).toHaveBeenCalledWith(SCOPE, {
            kind: 'session',
            sessionId: 'session-a',
        });
    });

    it('does not refresh a visible draft after its server/account scope changes', async () => {
        let activeScope: ServerAccountScope | null = SCOPE;
        const materializeExact = vi.fn(async () => undefined);

        await expect(materializeVisibleExistingSessionDraft({
            sessionId: 'session-a',
            capturedScope: SCOPE,
            readActiveScope: () => activeScope,
            ensureRuntimeReady: async () => {
                activeScope = { serverId: 'server-b', accountId: 'account-a' };
            },
            materializeExact,
        })).resolves.toBe(false);

        expect(materializeExact).not.toHaveBeenCalled();
    });
});

function sessionDocument(text: string, mutation: number): SessionDraftDocumentV1 {
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
