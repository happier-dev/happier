import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import {
    loadPendingOutboxForSession,
    removePendingOutboxMessage,
    savePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getPendingMessageVisualState } from '@/components/sessions/pending/pendingMessageVisualState';

import {
    deletePendingMessageV2,
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
    restoreDiscardedPendingMessageV2,
    sendPendingDeliveryAsNewV2,
    retryPendingOutboxOperationV2,
} from './pendingQueueV2';
import { buildSession, currentPendingEnqueueAck, resetPendingQueueState } from './pendingQueueV2.testHelpers';

function body(localId: string, text: string): string {
    return JSON.stringify({
        localId,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text }, meta: {} } },
        messageRole: 'user',
        requestedAction: { v: 1, kind: 'enqueue' },
    });
}

function persist(params: Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    scope: Readonly<{ serverId: string; accountId: string }>;
    operation: 'enqueue' | 'cancel';
}>): void {
    savePendingOutboxMessage({
        sessionId: params.sessionId,
        localId: params.localId,
        createdAt: 111,
        text: params.text,
        rawRecord: { role: 'user', content: { type: 'text', text: params.text }, meta: {} },
        operation: params.operation,
        request: { v: 1, body: body(params.localId, params.text) },
    }, params.scope);
    replayPersistedPendingOutboxForSession(params.sessionId, params.scope);
}

function response(
    localId: string,
    status: 'queued' | 'blocked' | 'discarded',
    options?: Readonly<{
        text?: string;
        blockedReason?: 'unsupported_action';
        rawRecord?: unknown;
        deliveryStatus?: 'external_handoff';
        requestedAction?: { v: 1; kind: 'send_now' };
    }>,
): Response {
    return new Response(JSON.stringify({
        pending: [{
            localId,
            content: {
                t: 'plain',
                v: options?.rawRecord ?? {
                    role: 'user',
                    content: { type: 'text', text: options?.text ?? `server ${status}` },
                    meta: {},
                },
            },
            status,
            ...(options?.requestedAction ? { requestedAction: options.requestedAction } : {}),
            ...(status === 'blocked'
                ? { deliveryStatus: { status: 'blocked', reason: options?.blockedReason ?? 'unsupported_action' } }
                : options?.deliveryStatus
                    ? { deliveryStatus: { status: options.deliveryStatus } }
                    : {}),
            position: 0,
            createdAt: 222,
            updatedAt: 223,
            discardedAt: status === 'discarded' ? 223 : null,
            discardedReason: status === 'discarded' ? 'manual' : null,
        }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('pendingQueueV2 scoped refresh reconciliation', () => {
    beforeEach(() => resetPendingQueueState());

    it('rejects a refresh superseded while its async scope check is awaiting', async () => {
        const sessionId = 'async-scope-refresh-session';
        const server = upsertServerProfile({ serverUrl: 'https://async-scope.example.test', name: 'Async scope' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let releaseNewer!: () => void;
        const newerGate = new Promise<void>((resolve) => { releaseNewer = resolve; });
        let newerRefresh: Promise<void> | null = null;
        let scopeCheckCount = 0;

        const firstRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: async () => {
                scopeCheckCount += 1;
                if (scopeCheckCount === 3) {
                    newerRefresh = fetchAndApplyPendingMessagesV2({
                        sessionId,
                        encryption,
                        outboxScope: scope,
                        isOutboxScopeCurrent: () => true,
                        request: async () => {
                            await newerGate;
                            return response('newer-local', 'queued', { text: 'newer snapshot' });
                        },
                    });
                }
                return true;
            },
            request: async () => response('older-local', 'queued', { text: 'older snapshot' }),
        });
        await firstRefresh;

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(newerRefresh).not.toBeNull();
        releaseNewer();
        await newerRefresh!;
    });

    it('rejects a held A response after active server changes while profile scope is still A', async () => {
        const sessionId = 'transition-gap-session';
        const localId = 'transition-gap-local';
        const serverA = upsertServerProfile({ serverUrl: 'https://transition-a.example.test', name: 'A' });
        const serverB = upsertServerProfile({ serverUrl: 'https://transition-b.example.test', name: 'B' });
        const scopeA = { serverId: serverA.id, accountId: 'account-a' } as const;
        const scopeB = { serverId: serverB.id, accountId: 'account-b' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(serverA.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scopeA);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scopeA,
            request: async () => {
                await held;
                return response(localId, 'queued');
            },
        });

        setActiveServerId(serverB.id, { scope: 'tab' });
        persist({ sessionId, localId, text: 'scope B durable', scope: scopeB, operation: 'enqueue' });
        release();
        await refresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ text: 'scope B durable', pendingOutboxScope: scopeB }),
        ]);
    });

    it('keeps a local-only row in local durable custody before server persistence is proven', async () => {
        const sessionId = 'local-only-session';
        const localId = 'local-only-local';
        const server = upsertServerProfile({ serverUrl: 'https://local-only.example.test', name: 'Local only' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        persist({ sessionId, localId, text: 'local durable custody', scope, operation: 'enqueue' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(8));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                text: 'local durable custody',
                pendingOutboxScope: scope,
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue' }),
        ]);
    });

    it('lets a same-localId server Pending row win and retires the local projection', async () => {
        const sessionId = 'pending-collision-session';
        const localId = 'pending-collision-local';
        const server = upsertServerProfile({ serverUrl: 'https://pending.example.test', name: 'Pending' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        persist({ sessionId, localId, text: 'same canonical content', scope, operation: 'enqueue' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', { text: 'same canonical content' }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'same canonical content',
                pendingDeliveryStatus: 'server_queued',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
        expect(replayPersistedPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it('keeps cancellation custody while a same-localId discarded server row still exists', async () => {
        const sessionId = 'discarded-collision-session';
        const localId = 'discarded-collision-local';
        const server = upsertServerProfile({ serverUrl: 'https://discarded.example.test', name: 'Discarded' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        persist({ sessionId, localId, text: 'durable cancel', scope, operation: 'cancel' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(8));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'discarded'),
        });

        expect(storage.getState().sessionPending[sessionId]).toEqual(expect.objectContaining({
            messages: [],
            discarded: [expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'server discarded',
                discardedReason: 'manual',
            })],
        }));
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
        expect(replayPersistedPendingOutboxForSession(sessionId, scope)).toEqual([localId]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                pendingOutboxOperation: 'cancel',
                pendingOutboxScope: scope,
            }),
        ]);
    });

    it('retires conflicting enqueue custody once the same-id server row proves persistence', async () => {
        const sessionId = 'conflicting-envelope-session';
        const localId = 'conflicting-envelope-local';
        const server = upsertServerProfile({ serverUrl: 'https://conflict.example.test', name: 'Conflict' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        persist({ sessionId, localId, text: 'stale local envelope', scope, operation: 'enqueue' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(10));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', {
                text: 'canonical server envelope',
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'canonical server envelope',
                pendingDeliveryStatus: 'server_queued',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);

        expect(replayPersistedPendingOutboxForSession(sessionId, scope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'canonical server envelope',
            }),
        ]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
    });

    it('retires external-handoff enqueue custody when an ordinary same-id server row exists', async () => {
        const sessionId = 'delivery-mode-conflict-session';
        const localId = 'delivery-mode-conflict-local';
        const server = upsertServerProfile({ serverUrl: 'https://delivery-mode.example.test', name: 'Delivery mode' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        const rawRecord = { role: 'user', content: { type: 'text', text: 'same content' }, meta: {} } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'same content',
            rawRecord,
            operation: 'enqueue',
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    deliveryMode: 'external_handoff',
                }),
            },
        }, scope);
        replayPersistedPendingOutboxForSession(sessionId, scope);
        const encryption = await Encryption.create(new Uint8Array(32).fill(12));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', { text: 'same content' }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({
            source: 'server_pending',
            text: 'same content',
        });
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it('retires enqueue custody when the same-id server row has a conflicting requested action', async () => {
        const sessionId = 'action-conflict-session';
        const localId = 'action-conflict-local';
        const server = upsertServerProfile({ serverUrl: 'https://action-conflict.example.test', name: 'Action conflict' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        persist({ sessionId, localId, text: 'same content', scope, operation: 'enqueue' });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(15)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', {
                text: 'same content',
                requestedAction: { v: 1, kind: 'send_now' },
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({
            source: 'server_pending',
            text: 'same content',
            pendingRequestedAction: { v: 1, kind: 'send_now' },
        });
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it('retires ordinary enqueue custody when a same-id server external handoff exists', async () => {
        const sessionId = 'server-delivery-mode-conflict-session';
        const localId = 'server-delivery-mode-conflict-local';
        const server = upsertServerProfile({ serverUrl: 'https://server-delivery-mode.example.test', name: 'Server delivery mode' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        persist({ sessionId, localId, text: 'same content', scope, operation: 'enqueue' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(13));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', {
                text: 'same content',
                deliveryStatus: 'external_handoff',
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({
            source: 'server_pending',
            text: 'same content',
            pendingDeliveryStatus: 'external_handoff',
        });
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it('retires enqueue custody when same-id server ciphertext differs', async () => {
        const sessionId = 'ciphertext-conflict-session';
        const localId = 'ciphertext-conflict-local';
        const server = upsertServerProfile({ serverUrl: 'https://ciphertext.example.test', name: 'Ciphertext' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        const rawRecord = { role: 'user', content: { type: 'text', text: 'same decrypted content' }, meta: {} } as const;
        const localCiphertext = 'local-frozen-ciphertext';
        const serverCiphertext = 'server-frozen-ciphertext';
        // Encryption is the genuine boundary under test; keep the reconciliation path real.
        const encryption = {
            getSessionEncryption: () => ({
                decryptRaw: async (payload: string) => payload === serverCiphertext ? rawRecord : null,
            }),
        } as unknown as Encryption;
        storage.getState().applySessions([buildSession({ sessionId })]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'same decrypted content',
            rawRecord,
            operation: 'enqueue',
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    ciphertext: localCiphertext,
                    messageRole: 'user',
                }),
            },
        }, scope);
        replayPersistedPendingOutboxForSession(sessionId, scope);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    messageRole: 'user',
                    content: { t: 'encrypted', c: serverCiphertext },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({
            source: 'server_pending',
            text: 'same decrypted content',
        });
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it("converges an ambiguous POST to the server snapshot without 'Message not sent'", async () => {
        const sessionId = 'ambiguous-post-snapshot-session';
        const localId = 'ambiguous-post-snapshot-local';
        const server = upsertServerProfile({ serverUrl: 'https://ambiguous.example.test', name: 'Ambiguous' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        const encryption = await Encryption.create(new Uint8Array(32).fill(11));

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'committed despite lost response',
            encryption,
            request: async () => {
                throw new TypeError('Failed to fetch');
            },
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
        })).resolves.toEqual({ localId, accepted: false });
        const [retainedOutboxRow] = loadPendingOutboxForSession(sessionId, scope);
        expect(retainedOutboxRow).toBeDefined();

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', {
                rawRecord: retainedOutboxRow?.rawRecord,
            }),
        });

        const message = storage.getState().sessionPending[sessionId]?.messages[0];
        expect(message).toEqual(expect.objectContaining({
            localId,
            source: 'server_pending',
            text: 'committed despite lost response',
        }));
        expect(message && getPendingMessageVisualState(message)).toMatchObject({ kind: 'queued' });
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it('preserves and canonicalizes an acknowledged external handoff across an empty refresh regardless of projection source', async () => {
        const sessionId = 'external-handoff-empty-refresh';
        const localId = 'external-handoff-local';
        const scope = { serverId: 'external-server', accountId: 'external-account' } as const;
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            pendingOutboxOperation: 'enqueue',
            text: 'external handoff',
            rawRecord: { role: 'user', content: { type: 'text', text: 'external handoff' }, meta: {} },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(12)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'external_handoff',
                pendingOutboxScope: scope,
                pendingOutboxOperation: undefined,
            }),
        ]);
    });

    it('deduplicates acknowledged external handoff and durable enqueue custody by scoped projection identity', async () => {
        const sessionId = 'external-handoff-outbox-overlap';
        const localId = 'external-handoff-outbox-local';
        const scope = { serverId: 'external-server', accountId: 'external-account' } as const;
        persist({ sessionId, localId, text: 'durable retry', scope, operation: 'enqueue' });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-handoff-synthetic-projection',
            localId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'acknowledged external handoff',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'acknowledged external handoff' },
                meta: {},
            },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(22)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'external_handoff',
                pendingOutboxScope: scope,
                text: 'acknowledged external handoff',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it('does not let an already-running retry downgrade retained external-handoff custody', async () => {
        const sessionId = 'external-handoff-in-flight-retry';
        const localId = 'external-handoff-in-flight-local';
        const scope = { serverId: 'external-server', accountId: 'external-account' } as const;
        persist({ sessionId, localId, text: 'stale retry content', scope, operation: 'enqueue' });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-handoff-in-flight-projection',
            localId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'canonical external content',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'canonical external content' },
                meta: {},
            },
        });
        let retryStarted!: () => void;
        const retryStartedGate = new Promise<void>((resolve) => { retryStarted = resolve; });
        let releaseRetry!: () => void;
        const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
        const retry = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: async (_path, init) => {
                retryStarted();
                await retryGate;
                return currentPendingEnqueueAck(init);
            },
        });
        await retryStartedGate;

        let finalScopeCheckStarted!: () => void;
        const finalScopeCheckStartedGate = new Promise<void>((resolve) => { finalScopeCheckStarted = resolve; });
        let releaseFinalScopeCheck!: () => void;
        const finalScopeCheckGate = new Promise<void>((resolve) => { releaseFinalScopeCheck = resolve; });
        let scopeCheckCount = 0;
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(24)),
            outboxScope: scope,
            isOutboxScopeCurrent: async () => {
                scopeCheckCount += 1;
                if (scopeCheckCount === 3) {
                    finalScopeCheckStarted();
                    await finalScopeCheckGate;
                }
                return true;
            },
            request: async () => Response.json({ pending: [] }),
        });
        await finalScopeCheckStartedGate;
        releaseFinalScopeCheck();
        await Promise.resolve();
        await Promise.resolve();
        releaseRetry();

        await expect(Promise.all([retry, refresh])).resolves.toEqual([
            { accepted: true },
            undefined,
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'canonical external content',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it.each(['before', 'after'] as const)(
        'applies an authoritative refresh that starts %s a retry instead of letting retry suppress it',
        async (refreshOrder) => {
        const sessionId = `refresh-started-${refreshOrder}-retry`;
        const localId = `refresh-started-${refreshOrder}-retry-local`;
        const scope = { serverId: `refresh-${refreshOrder}-retry-server`, accountId: `refresh-${refreshOrder}-retry-account` } as const;
        persist({ sessionId, localId, text: 'stale retry content', scope, operation: 'enqueue' });
        let retryStarted!: () => void;
        const retryStartedGate = new Promise<void>((resolve) => { retryStarted = resolve; });
        let releaseRetry!: () => void;
        const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
        const startRetry = () => retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: async (_path, init) => {
                retryStarted();
                await retryGate;
                return currentPendingEnqueueAck(init);
            },
        });
        let finalScopeCheckStarted!: () => void;
        const finalScopeCheckStartedGate = new Promise<void>((resolve) => { finalScopeCheckStarted = resolve; });
        let releaseFinalScopeCheck!: () => void;
        const finalScopeCheckGate = new Promise<void>((resolve) => { releaseFinalScopeCheck = resolve; });
        let scopeCheckCount = 0;
        const encryption = await Encryption.create(new Uint8Array(32).fill(25));
        const startRefresh = () => fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: async () => {
                scopeCheckCount += 1;
                if (scopeCheckCount === 3) {
                    finalScopeCheckStarted();
                    await finalScopeCheckGate;
                }
                return true;
            },
            request: async () => response(localId, 'queued', { text: 'authoritative refresh content' }),
        });

        const retry = refreshOrder === 'before' ? null : startRetry();
        if (retry) await retryStartedGate;
        const refresh = startRefresh();
        await finalScopeCheckStartedGate;
        const orderedRetry = retry ?? startRetry();
        if (!retry) await retryStartedGate;

        releaseRetry();
        await orderedRetry;
        releaseFinalScopeCheck();
        await refresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'authoritative refresh content',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
    });

    it.each([
        ['failed', async (): Promise<Response> => new Response(null, { status: 500 })],
        ['unconfirmed', async (): Promise<Response> => { throw new TypeError('Failed to fetch'); }],
    ])('does not write %s send state after an authoritative refresh retires retry custody', async (forbiddenSendState, retryResult) => {
        const sessionId = `retry-error-after-refresh-${forbiddenSendState}`;
        const localId = 'retry-error-after-refresh-local';
        const scope = { serverId: `retry-error-${forbiddenSendState}-server`, accountId: 'retry-error-account' } as const;
        persist({ sessionId, localId, text: 'stale retry content', scope, operation: 'enqueue' });
        let retryStarted!: () => void;
        const retryStartedGate = new Promise<void>((resolve) => { retryStarted = resolve; });
        let releaseRetry!: () => void;
        const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
        const retry = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: async () => {
                retryStarted();
                await retryGate;
                return await retryResult();
            },
        });
        await retryStartedGate;

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(26)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', {
                text: 'authoritative external handoff',
                deliveryStatus: 'external_handoff',
            }),
        });
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);

        releaseRetry();
        await retry.catch(() => undefined);

        const canonical = storage.getState().sessionPending[sessionId]?.messages[0];
        expect(canonical).toMatchObject({
            localId,
            source: 'server_pending',
            pendingDeliveryStatus: 'external_handoff',
            text: 'authoritative external handoff',
        });
        expect(canonical?.sendState).not.toBe(forbiddenSendState);
    });

    it('does not overwrite an authoritative ordinary row when refresh retires custody during the cancellation-helper await', async () => {
        const sessionId = 'ordinary-retry-success-after-refresh-retirement';
        const localId = 'ordinary-retry-success-after-refresh-retirement-local';
        const scope = { serverId: 'ordinary-retry-refresh-server', accountId: 'ordinary-retry-refresh-account' } as const;
        persist({ sessionId, localId, text: 'stale retry content', scope, operation: 'enqueue' });
        let retryStarted!: () => void;
        const retryStartedGate = new Promise<void>((resolve) => { retryStarted = resolve; });
        let releaseRetry!: () => void;
        const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
        const authoritativeRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'authoritative ordinary content' },
            meta: { owner: 'server' },
        };
        const persistence = getPersistenceStorage();
        const outboxKey = scopedSessionLocalStateKey('session-pending-outbox-v1', scope);
        const originalGetString = persistence.getString.bind(persistence);
        let outboxReadCount = 0;
        let retirementQueued = false;
        const getStringSpy = vi.spyOn(persistence, 'getString').mockImplementation((key) => {
            const value = originalGetString(key);
            if (key === outboxKey) {
                outboxReadCount += 1;
                if (outboxReadCount === 4 && !retirementQueued) {
                    retirementQueued = true;
                    // Read #3 is retry's post-response fence; read #4 is the helper's
                    // false-path lookup. Queue the canonical refresh application before
                    // the helper's resolved Promise resumes its caller.
                    queueMicrotask(() => {
                        removePendingOutboxMessage(sessionId, localId, scope);
                        storage.getState().applyPendingSnapshot(sessionId, {
                            messages: [{
                                id: localId,
                                localId,
                                createdAt: 222,
                                updatedAt: 223,
                                source: 'server_pending',
                                deliveryStatus: 'accepted',
                                pendingOutboxScope: scope,
                                text: 'authoritative ordinary content',
                                rawRecord: authoritativeRawRecord,
                            }],
                            discarded: [],
                        });
                    });
                }
            }
            return value;
        });
        const retry = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: async (_path, init) => {
                retryStarted();
                await retryGate;
                return currentPendingEnqueueAck(init);
            },
        });
        await retryStartedGate;

        releaseRetry();
        await retry;
        getStringSpy.mockRestore();

        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'authoritative ordinary content',
                rawRecord: authoritativeRawRecord,
            }),
        ]);
    });

    it('does not overwrite an authoritative ordinary row when refresh retires initial enqueue custody during the cancellation-helper await', async () => {
        const sessionId = 'ordinary-initial-enqueue-after-refresh-retirement';
        const localId = 'ordinary-initial-enqueue-after-refresh-retirement-local';
        const scope = { serverId: 'ordinary-initial-enqueue-server', accountId: 'ordinary-initial-enqueue-account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        const authoritativeRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'authoritative initial enqueue content' },
            meta: { owner: 'server' },
        };
        const persistence = getPersistenceStorage();
        const outboxKey = scopedSessionLocalStateKey('session-pending-outbox-v1', scope);
        const originalGetString = persistence.getString.bind(persistence);
        let outboxReadCount = 0;
        let retirementQueued = false;
        const getStringSpy = vi.spyOn(persistence, 'getString').mockImplementation((key) => {
            const value = originalGetString(key);
            if (key === outboxKey) {
                outboxReadCount += 1;
                if (outboxReadCount === 4 && !retirementQueued) {
                    retirementQueued = true;
                    // Read #3 selects the saved enqueue row; read #4 is the helper's
                    // false-path lookup. Apply refresh before its Promise resumes the caller.
                    queueMicrotask(() => {
                        removePendingOutboxMessage(sessionId, localId, scope);
                        storage.getState().applyPendingSnapshot(sessionId, {
                            messages: [{
                                id: localId,
                                localId,
                                createdAt: 222,
                                updatedAt: 223,
                                source: 'server_pending',
                                deliveryStatus: 'accepted',
                                pendingOutboxScope: scope,
                                text: 'authoritative initial enqueue content',
                                rawRecord: authoritativeRawRecord,
                            }],
                            discarded: [],
                        });
                    });
                }
            }
            return value;
        });

        const result = await enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'stale initial enqueue content',
            encryption: await Encryption.create(new Uint8Array(32).fill(19)),
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });
        getStringSpy.mockRestore();

        expect(result).toEqual({ localId, accepted: true });
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'authoritative initial enqueue content',
                rawRecord: authoritativeRawRecord,
            }),
        ]);
    });

    it.each(['initial', 'retry'] as const)(
        'preserves an enqueue-to-cancel transition during the cancellation-helper await (%s)',
        async (attempt) => {
            const sessionId = `enqueue-to-cancel-helper-await-${attempt}`;
            const localId = `enqueue-to-cancel-helper-await-${attempt}-local`;
            const scope = { serverId: `enqueue-to-cancel-${attempt}-server`, accountId: 'account' } as const;
            storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
            if (attempt === 'retry') {
                persist({ sessionId, localId, text: 'retry then cancel', scope, operation: 'enqueue' });
            }

            const requestCalls: Array<{ path: string; method: string | undefined }> = [];
            const request = async (path: string, init?: RequestInit) => {
                requestCalls.push({ path, method: init?.method });
                return init?.method === 'DELETE'
                    ? new Response(null, { status: 204 })
                    : currentPendingEnqueueAck(init);
            };
            const persistence = getPersistenceStorage();
            const outboxKey = scopedSessionLocalStateKey('session-pending-outbox-v1', scope);
            const originalGetString = persistence.getString.bind(persistence);
            let outboxReadCount = 0;
            let cancellation: Promise<void> | null = null;
            const getStringSpy = vi.spyOn(persistence, 'getString').mockImplementation((key) => {
                const value = originalGetString(key);
                if (key === outboxKey) {
                    outboxReadCount += 1;
                    if (outboxReadCount === 4 && cancellation === null) {
                        // The helper has observed enqueue custody and is about to yield its
                        // false result. Transition through the real cancellation owner first.
                        queueMicrotask(() => {
                            cancellation = deletePendingMessageV2({
                                sessionId,
                                pendingId: localId,
                                outboxScope: scope,
                                request,
                            });
                        });
                    }
                }
                return value;
            });

            const submitResult = attempt === 'initial'
                ? await enqueuePendingMessageV2({
                    sessionId,
                    localId,
                    text: 'initial then cancel',
                    encryption: await Encryption.create(new Uint8Array(32).fill(20)),
                    outboxScope: scope,
                    serverWireMode: 'pending_input_v1',
                    request,
                })
                : await retryPendingOutboxOperationV2({
                    sessionId,
                    localId,
                    outboxScope: scope,
                    serverWireMode: 'pending_input_v1',
                    request,
                });
            await cancellation;
            getStringSpy.mockRestore();

            if (attempt === 'initial') {
                expect(submitResult).toEqual({ localId, accepted: true, cancelled: true });
            } else {
                expect(submitResult).toEqual({ accepted: true });
            }
            expect(requestCalls).toEqual([
                { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
                { path: `/v2/sessions/${sessionId}/pending/${localId}`, method: 'DELETE' },
            ]);
            expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        },
    );

    it.each(['initial', 'retry'] as const)(
        'retires accepted enqueue custody before a promise-resolution cancellation gap (%s)',
        async (attempt) => {
            const sessionId = `accepted-retirement-before-resolution-${attempt}`;
            const localId = `accepted-retirement-before-resolution-${attempt}-local`;
            const scope = { serverId: `accepted-retirement-${attempt}-server`, accountId: 'account' } as const;
            storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
            if (attempt === 'retry') {
                persist({ sessionId, localId, text: 'retry accepted then cancel', scope, operation: 'enqueue' });
            }

            const requestCalls: Array<{ path: string; method: string | undefined }> = [];
            const request = async (path: string, init?: RequestInit) => {
                requestCalls.push({ path, method: init?.method });
                return init?.method === 'DELETE'
                    ? new Response(null, { status: 204 })
                    : currentPendingEnqueueAck(init);
            };
            const persistence = getPersistenceStorage();
            const outboxKey = scopedSessionLocalStateKey('session-pending-outbox-v1', scope);
            const originalGetString = persistence.getString.bind(persistence);
            let outboxReadCount = 0;
            let cancellation: Promise<void> | null = null;
            const getStringSpy = vi.spyOn(persistence, 'getString').mockImplementation((key) => {
                const value = originalGetString(key);
                if (key === outboxKey) {
                    outboxReadCount += 1;
                    if (outboxReadCount === 5 && cancellation === null) {
                        // The serialized callback selected final enqueue custody. Queue
                        // cancellation before its resolved result resumes any outer owner.
                        queueMicrotask(() => {
                            cancellation = deletePendingMessageV2({
                                sessionId,
                                pendingId: localId,
                                outboxScope: scope,
                                request,
                            });
                        });
                    }
                }
                return value;
            });

            const submitResult = attempt === 'initial'
                ? await enqueuePendingMessageV2({
                    sessionId,
                    localId,
                    text: 'initial accepted then cancel',
                    encryption: await Encryption.create(new Uint8Array(32).fill(21)),
                    outboxScope: scope,
                    serverWireMode: 'pending_input_v1',
                    request,
                })
                : await retryPendingOutboxOperationV2({
                    sessionId,
                    localId,
                    outboxScope: scope,
                    serverWireMode: 'pending_input_v1',
                    request,
                });
            await cancellation;
            getStringSpy.mockRestore();

            expect(submitResult).toEqual(attempt === 'initial'
                ? { localId, accepted: true }
                : { accepted: true });
            expect(requestCalls).toEqual([
                { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
                { path: `/v2/sessions/${sessionId}/pending/${localId}`, method: 'DELETE' },
            ]);
            expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([]);
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        },
    );

    it('keeps durable cancellation as the sole custody when it overlaps an acknowledged external handoff', async () => {
        const sessionId = 'external-handoff-cancel-overlap';
        const localId = 'external-handoff-cancel-local';
        const scope = { serverId: 'external-server', accountId: 'external-account' } as const;
        persist({ sessionId, localId, text: 'cancel custody', scope, operation: 'cancel' });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-handoff-cancel-synthetic-projection',
            localId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'acknowledged external handoff',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'acknowledged external handoff' },
                meta: {},
            },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(23)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                pendingOutboxScope: scope,
                pendingOutboxOperation: 'cancel',
                text: 'cancel custody',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
    });

    it('binds a fetched external handoff to its server-account scope across an empty refresh', async () => {
        const sessionId = 'fetched-external-handoff-empty-refresh';
        const localId = 'fetched-external-handoff-local';
        const scope = { serverId: 'external-server', accountId: 'external-account' } as const;
        const encryption = await Encryption.create(new Uint8Array(32).fill(16));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', {
                text: 'fetched external handoff',
                deliveryStatus: 'external_handoff',
            }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                pendingDeliveryStatus: 'external_handoff',
                pendingOutboxScope: scope,
            }),
        ]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                pendingDeliveryStatus: 'external_handoff',
                pendingOutboxScope: scope,
            }),
        ]);
    });

    it('does not preserve an unresolved external handoff owned by another server-account scope', async () => {
        const sessionId = 'external-handoff-cross-scope';
        const localId = 'external-handoff-cross-scope-local';
        const scope = { serverId: 'external-server', accountId: 'current-account' } as const;
        const otherScope = { serverId: 'external-server', accountId: 'other-account' } as const;
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: otherScope, text: 'other account',
            rawRecord: { role: 'user', content: { type: 'text', text: 'other account' }, meta: {} },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(13)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('reallocates retained external-handoff and legacy-unscoped projections across server collection id collisions', async () => {
        const sessionId = 'retained-projection-refresh-collisions';
        const scope = { serverId: 'collision-server', accountId: 'collision-account' } as const;
        const externalLocalId = 'retained-external-local';
        const legacyLocalId = 'retained-legacy-local';
        const queuedServerLocalId = 'queued-server-collision-id';
        const discardedServerLocalId = 'discarded-server-collision-id';
        const externalRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'retained external' },
            meta: {},
        };
        const legacyRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'retained legacy' },
            meta: {},
        };
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: queuedServerLocalId,
            localId: externalLocalId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'retained external',
            rawRecord: externalRawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: discardedServerLocalId,
            localId: legacyLocalId,
            createdAt: 2,
            updatedAt: 2,
            deliveryStatus: 'accepted',
            text: 'retained legacy',
            rawRecord: legacyRawRecord,
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(21)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [
                    {
                        localId: queuedServerLocalId,
                        content: {
                            t: 'plain',
                            v: { role: 'user', content: { type: 'text', text: 'server queued' }, meta: {} },
                        },
                        status: 'queued',
                        position: 0,
                        createdAt: 3,
                        updatedAt: 3,
                        discardedAt: null,
                        discardedReason: null,
                    },
                    {
                        localId: discardedServerLocalId,
                        content: {
                            t: 'plain',
                            v: { role: 'user', content: { type: 'text', text: 'server discarded' }, meta: {} },
                        },
                        status: 'discarded',
                        position: 1,
                        createdAt: 4,
                        updatedAt: 4,
                        discardedAt: 4,
                        discardedReason: 'manual',
                    },
                ],
            }),
        });

        const bucket = storage.getState().sessionPending[sessionId];
        expect(bucket?.messages).toContainEqual(expect.objectContaining({
            id: queuedServerLocalId,
            localId: queuedServerLocalId,
            source: 'server_pending',
            text: 'server queued',
        }));
        expect(bucket?.discarded).toContainEqual(expect.objectContaining({
            id: discardedServerLocalId,
            localId: discardedServerLocalId,
            source: 'server_pending',
            text: 'server discarded',
        }));
        const retainedExternal = bucket?.messages.find((message) => message.localId === externalLocalId);
        expect(retainedExternal).toMatchObject({
            source: 'server_pending',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'retained external',
        });
        expect(retainedExternal?.id).not.toBe(queuedServerLocalId);
        const retainedLegacy = bucket?.messages.find((message) => message.localId === legacyLocalId);
        expect(retainedLegacy).toMatchObject({
            deliveryStatus: 'accepted',
            text: 'retained legacy',
        });
        expect(retainedLegacy?.id).not.toBe(discardedServerLocalId);
    });

    it('preserves crossed retained projection identities when one allocation targets the other original id', async () => {
        const sessionId = 'crossed-retained-projection-ids';
        const scope = { serverId: 'collision-server', accountId: 'collision-account' } as const;
        const serverCollisionId = 'server-collision-id';
        const durableProjectionId = 'durable-original-projection-id';
        const durableLocalId = 'durable-local-id';
        const durableRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'durable custody' },
            meta: {},
        };
        savePendingOutboxMessage({
            sessionId,
            localId: durableLocalId,
            createdAt: 1,
            text: 'durable custody',
            rawRecord: durableRawRecord,
            operation: 'enqueue',
            request: { v: 1, body: body(durableLocalId, 'durable custody') },
        }, scope);
        storage.getState().upsertPendingMessage(sessionId, {
            id: serverCollisionId,
            localId: durableProjectionId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'retained external',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'retained external' },
                meta: {},
            },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: durableProjectionId,
            localId: durableLocalId,
            createdAt: 2,
            updatedAt: 2,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'unconfirmed',
            pendingOutboxScope: scope,
            pendingOutboxOperation: 'enqueue',
            text: 'durable custody',
            rawRecord: durableRawRecord,
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(25)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(serverCollisionId, 'queued', { text: 'server authority' }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.filter((message) => message.localId === durableProjectionId)).toEqual([
            expect.objectContaining({
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'retained external',
            }),
        ]);
        expect(messages.filter((message) => message.localId === durableLocalId)).toEqual([
            expect.objectContaining({
                source: 'local_outbound',
                pendingOutboxOperation: 'enqueue',
                text: 'durable custody',
            }),
        ]);
        expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    });

    it('keeps same-ID server authority alongside a distinct blocked quarantine projection', async () => {
        const sessionId = 'quarantined-custody-server-collision';
        const localId = 'quarantined-collision';
        const scope = { serverId: 'quarantine-server', accountId: 'quarantine-account' } as const;
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
            operation: 'future-operation' as never,
            request: { v: 1, body: body(localId, 'quarantined') },
        }, scope);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([
            expect.objectContaining({ operation: 'quarantined', quarantineReason: 'unsupported_persisted_operation' }),
        ]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(14)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', { text: 'authoritative server content' }),
        });

        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([
            expect.objectContaining({ operation: 'quarantined', quarantineReason: 'unsupported_persisted_operation' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: localId,
                localId,
                source: 'server_pending',
                text: 'authoritative server content',
                pendingDeliveryStatus: 'server_queued',
            }),
            expect.objectContaining({
                id: expect.stringMatching(/^pending-outbox-quarantine:/),
                localId,
                source: 'local_outbound',
                text: 'quarantined',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation',
            }),
        ]);
        const quarantined = storage.getState().sessionPending[sessionId]?.messages[1];
        expect(quarantined?.sendState).toBeUndefined();
        expect(quarantined?.pendingOutboxOperation).toBeUndefined();
        const diagnosticId = quarantined!.id;

        expect(replayPersistedPendingOutboxForSession(sessionId, scope)).toEqual([]);
        expect(replayPersistedPendingOutboxForSession(sessionId, scope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: localId, localId, source: 'server_pending' }),
            expect.objectContaining({
                id: diagnosticId,
                localId,
                source: 'local_outbound',
                pendingDeliveryStatus: 'blocked',
            }),
        ]);
    });

    it('keeps quarantine visible when a legitimate server localId equals its synthetic projection id', async () => {
        const sessionId = 'quarantine-synthetic-id-collision';
        const localId = 'quarantine-durable-local';
        const scope = { serverId: 'quarantine-server', accountId: 'quarantine-account' } as const;
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
            operation: 'future-operation' as never,
            request: { v: 1, body: body(localId, 'quarantined') },
        }, scope);
        expect(replayPersistedPendingOutboxForSession(sessionId, scope)).toEqual([]);
        const syntheticCollisionId = storage.getState().sessionPending[sessionId]?.messages[0]?.id;
        expect(syntheticCollisionId).toMatch(/^pending-outbox-quarantine:/);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(16)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(syntheticCollisionId!, 'queued', { text: 'canonical server row' }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages).toEqual([
            expect.objectContaining({
                id: syntheticCollisionId,
                localId: syntheticCollisionId,
                source: 'server_pending',
                text: 'canonical server row',
            }),
            expect.objectContaining({
                id: expect.not.stringMatching(new RegExp(`^${syntheticCollisionId}$`)),
                localId,
                source: 'local_outbound',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation',
            }),
        ]);
        expect(loadPendingOutboxForSession(sessionId, scope)).toEqual([
            expect.objectContaining({ localId, operation: 'quarantined' }),
        ]);
        const collisionSafeDiagnosticId = messages[1]!.id;
        expect(replayPersistedPendingOutboxForSession(sessionId, scope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
            syntheticCollisionId,
            collisionSafeDiagnosticId,
        ]);
        storage.getState().removePendingMessage(sessionId, syntheticCollisionId!);
        expect(replayPersistedPendingOutboxForSession(sessionId, scope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.id)).toEqual([
            collisionSafeDiagnosticId,
        ]);

        let transported = false;
        await expect(sendPendingDeliveryAsNewV2({
            sessionId,
            pendingId: collisionSafeDiagnosticId,
            encryption: await Encryption.create(new Uint8Array(32).fill(17)),
            outboxScope: scope,
            request: async () => {
                transported = true;
                return Response.json({ pending: [] });
            },
        })).rejects.toThrow('Persisted pending outbox row is quarantined');
        expect(transported).toBe(false);
    });

    it('keeps a refreshed canonical discarded row transportable across a quarantine diagnostic collision', async () => {
        const sessionId = 'quarantine-refresh-discarded-id-collision';
        const localId = 'quarantine-refresh-discarded';
        const scope = { serverId: 'quarantine-server', accountId: 'quarantine-account' } as const;
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
            operation: 'future-operation' as never,
            request: { v: 1, body: body(localId, 'quarantined') },
        }, scope);
        replayPersistedPendingOutboxForSession(sessionId, scope);
        const baseDiagnosticId = storage.getState().sessionPending[sessionId]?.messages[0]!.id;
        storage.getState().applyPendingSnapshot(sessionId, { messages: [], discarded: [] });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(18)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(baseDiagnosticId, 'discarded', { text: 'canonical discarded' }),
        });

        expect(storage.getState().sessionPending[sessionId]?.discarded).toEqual([
            expect.objectContaining({ id: baseDiagnosticId, text: 'canonical discarded' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: expect.not.stringMatching(new RegExp(`^${baseDiagnosticId}$`)),
                localId,
                pendingDeliveryStatus: 'blocked',
            }),
        ]);
        let requestCount = 0;
        await expect(restoreDiscardedPendingMessageV2({
            sessionId,
            pendingId: baseDiagnosticId,
            encryption: await Encryption.create(new Uint8Array(32).fill(19)),
            outboxScope: scope,
            request: async (_path, init) => {
                requestCount += 1;
                return init?.method === 'POST'
                    ? new Response(null, { status: 204 })
                    : Response.json({ pending: [] });
            },
        })).resolves.toBeUndefined();
        expect(requestCount).toBe(2);
    });

    it.each(['queued', 'discarded'] as const)(
        'reallocates a normal durable projection when refresh now occupies its preferred ID with %s',
        async (status) => {
            const sessionId = `normal-refresh-preferred-${status}`;
            const localId = `normal-refresh-local-${status}`;
            const scope = { serverId: 'refresh-server', accountId: 'refresh-account' } as const;
            const otherScope = { serverId: 'other-server', accountId: 'other-account' } as const;
            const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'durable' }, meta: {} };
            storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
            savePendingOutboxMessage({
                sessionId, localId, createdAt: 1, text: 'durable', rawRecord,
                request: { v: 1, body: body(localId, 'durable') },
            }, scope);
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId, localId, createdAt: 1, updatedAt: 1,
                source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: otherScope,
                text: 'initial collider', rawRecord,
            });
            replayPersistedPendingOutboxForSession(sessionId, scope);
            const preferredId = storage.getState().sessionPending[sessionId]?.messages.find((message) =>
                message.pendingOutboxScope?.accountId === scope.accountId)?.id;
            expect(preferredId).toBeTruthy();
            expect(preferredId).not.toBe(localId);
            storage.getState().removePendingMessage(sessionId, localId);

            await fetchAndApplyPendingMessagesV2({
                sessionId,
                encryption: await Encryption.create(new Uint8Array(32).fill(20)),
                outboxScope: scope,
                isOutboxScopeCurrent: () => true,
                request: async () => response(preferredId!, status, { text: `server ${status}` }),
            });

            const bucket = storage.getState().sessionPending[sessionId];
            const canonicalCollection = status === 'queued' ? bucket?.messages : bucket?.discarded;
            expect(canonicalCollection).toContainEqual(expect.objectContaining({
                id: preferredId,
                localId: preferredId,
                source: 'server_pending',
            }));
            const durableProjection = bucket?.messages.find((message) => message.localId === localId);
            expect(durableProjection).toMatchObject({
                source: 'local_outbound',
                pendingOutboxScope: scope,
                deliveryStatus: 'queued',
            });
            expect(durableProjection?.id).not.toBe(preferredId);
            expect(loadPendingOutboxForSession(sessionId, scope)).toHaveLength(1);
        },
    );

    it('canonicalizes an existing queued projection from quarantined custody during refresh without replay', async () => {
        const sessionId = 'quarantined-custody-existing-projection';
        const localId = 'quarantined-existing';
        const scope = { serverId: 'quarantine-server', accountId: 'quarantine-account' } as const;
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
            operation: 'future-operation' as never,
            request: { v: 1, body: body(localId, 'quarantined') },
        }, scope);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'local_outbound', deliveryStatus: 'queued', sendState: 'unconfirmed',
            pendingOutboxScope: scope, pendingOutboxOperation: 'enqueue', text: 'quarantined', rawRecord,
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(15)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation',
            }),
        ]);
        const quarantined = storage.getState().sessionPending[sessionId]?.messages[0];
        expect(quarantined?.sendState).toBeUndefined();
        expect(quarantined?.pendingOutboxOperation).toBeUndefined();
    });
});
