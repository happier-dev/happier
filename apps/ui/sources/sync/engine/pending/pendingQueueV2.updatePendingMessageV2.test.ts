import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { loadPendingOutboxForSession, savePendingOutboxMessage } from '@/sync/domains/state/pendingOutboxPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';
import {
    deletePendingMessageV2 as deletePendingMessageV2Impl,
    fetchAndApplyPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
    updatePendingMessageV2 as updatePendingMessageV2Impl,
} from './pendingQueueV2';
import {
    buildSession,
    createPendingQueueEncryption,
    getSessionEncryptionOrThrow,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

const outboxScope = { serverId: 'server-update', accountId: 'account-update' } as const;
const otherOutboxScope = { serverId: 'server-update', accountId: 'account-other' } as const;
const updatePendingMessageV2 = (
    params: Omit<Parameters<typeof updatePendingMessageV2Impl>[0], 'outboxScope'>,
) => updatePendingMessageV2Impl({ ...params, outboxScope });
const deletePendingMessageV2 = (
    params: Omit<Parameters<typeof deletePendingMessageV2Impl>[0], 'outboxScope'>,
) => deletePendingMessageV2Impl({ ...params, outboxScope });

describe('pendingQueueV2 updatePendingMessageV2', () => {
    beforeEach(() => {
        resetPendingQueueState();
    });

    it.each(['plain', 'e2ee'] as const)('replaces edited references and retains other metadata in %s pending messages', async (encryptionMode) => {
        const sessionId = 's_edit_references';
        const pendingId = 'p-edit-references';
        const oldReference = { kind: 'happier.session', ref: 'session:old', token: '@old' };
        const nextReference = { kind: 'happier.session', ref: 'session:new', token: '@new' };
        const localPath = '.happier/uploads/messages/m1/screen.png';
        const attachment = { type: 'localImage', kind: 'image', localPath, mimeType: 'image/png', provenance: { kind: 'sessionAttachmentUpload' } };
        const encryption = await createPendingQueueEncryption({ sessionId });
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1, text: 'ask @old',
            rawRecord: { role: 'user', content: { type: 'text', text: 'ask @old' }, meta: {
                sentFrom: 'web', custom: 'preserved',
                happierSkillMentions: [{ name: 'shadowed-old-skill' }],
                happierVendorPluginMentions: [{ vendorPluginRef: 'plugin://shadowed' }],
                happier: { kind: 'attachments.v1', payload: { attachments: [{ name: 'screen.png', path: localPath, mimeType: 'image/png', sizeBytes: 42 }] } },
                happierStructuredInputV1: { v: 1, mentions: [oldReference], attachments: [attachment] },
            } },
        });
        let writtenRecord: unknown;
        const request = async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            writtenRecord = encryptionMode === 'plain'
                ? body.content.v
                : await getSessionEncryptionOrThrow({ encryption, sessionId }).decryptRaw(body.ciphertext);
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({ sessionId, pendingId, text: 'ask @new', encryption, request,
            metaOverrides: { happierStructuredInputV1: { v: 1, mentions: [nextReference, oldReference] } },
        });
        expect(writtenRecord).toMatchObject({ meta: {
            custom: 'preserved', sentFrom: 'web', happierStructuredInputV1: { mentions: [nextReference], attachments: [expect.objectContaining(attachment)] },
        } });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.rawRecord).toEqual(writtenRecord);

        await updatePendingMessageV2({ sessionId, pendingId, text: 'plain edited text', encryption, request, metaOverrides: {} });
        const record = writtenRecord as { meta: Record<string, unknown> };
        expect(record.meta.custom).toBe('preserved');
        expect(record.meta.happierStructuredInputV1).not.toHaveProperty('mentions');
        expect(record.meta).not.toHaveProperty('happierSkillMentions');
        expect(record.meta).not.toHaveProperty('happierVendorPluginMentions');
    });

    it('retires exact-scope enqueue custody after a successful PATCH', async () => {
        const sessionId = 's_test_patch_retires_enqueue';
        const pendingId = 'p-enqueue';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1, source: 'server_pending',
            deliveryStatus: 'accepted', text: 'old', rawRecord,
        });
        (await savePendingOutboxMessage({
            sessionId, localId: pendingId, createdAt: 1, text: 'old', rawRecord,
            request: { v: 1, body: JSON.stringify({ localId: pendingId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope));

        await updatePendingMessageV2({
            sessionId, pendingId, text: 'new', encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => new Response('{}', { status: 200 }),
        });

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: pendingId, source: 'server_pending', text: 'new' }),
        ]);
    });

    it('acknowledges ambiguous enqueue custody after PATCH without manufacturing snapshot provenance', async () => {
        const sessionId = 's_test_patch_canonicalizes_ambiguous_enqueue';
        const pendingId = 'patch-canonicalizes-ambiguous-enqueue';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old ambiguous' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const save = async (scope: typeof outboxScope | typeof otherOutboxScope) => (await savePendingOutboxMessage({
            sessionId,
            localId: pendingId,
            createdAt: 1,
            text: 'old ambiguous',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({ localId: pendingId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }),
            },
        }, scope));
        (await save(outboxScope));
        (await save(otherOutboxScope));
        (await replayPersistedPendingOutboxForSession(sessionId, outboxScope));

        await updatePendingMessageV2({
            sessionId,
            pendingId,
            text: 'server-proven edit',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => new Response('{}', { status: 200 }),
        });

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect((await loadPendingOutboxForSession(sessionId, otherOutboxScope))).toEqual([
            expect.objectContaining({ localId: pendingId, operation: 'enqueue' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId: pendingId,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingOutboxOperation: undefined,
                sendState: undefined,
                text: 'server-proven edit',
            }),
        ]);

        let failedDeleteCalled = false;
        await expect(deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => {
                failedDeleteCalled = true;
                return new Response(null, { status: 500 });
            },
        })).rejects.toThrow('Failed to delete pending message (500)');
        expect(failedDeleteCalled).toBe(true);
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);

        let absentDeleteCalled = false;
        await deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => {
                absentDeleteCalled = true;
                return new Response(null, { status: 404 });
            },
        });
        expect(absentDeleteCalled).toBe(true);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('updates the exact canonical row when an earlier quarantine diagnostic shares its localId', async () => {
        const sessionId = 's_test_patch_exact_canonical_collision';
        const pendingId = 'canonical-collision-local';
        const diagnosticId = 'quarantine-diagnostic-id';
        const canonicalRawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'canonical old' }, meta: { owner: 'server' } };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: diagnosticId,
            localId: pendingId,
            createdAt: 1,
            updatedAt: 1,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: outboxScope,
            pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            text: 'diagnostic must remain unchanged',
            rawRecord: { role: 'user', content: { type: 'text', text: 'diagnostic must remain unchanged' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'canonical old',
            rawRecord: canonicalRawRecord,
        });

        await updatePendingMessageV2({
            sessionId,
            pendingId,
            text: 'canonical new',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => new Response('{}', { status: 200 }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: diagnosticId,
                pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
                text: 'diagnostic must remain unchanged',
            }),
            expect.objectContaining({
                id: pendingId,
                source: 'server_pending',
                text: 'canonical new',
                rawRecord: expect.objectContaining({
                    content: { type: 'text', text: 'canonical new' },
                    meta: { owner: 'server' },
                }),
            }),
        ]);
    });

    it('updates same-scope canonical authority despite real same-localId quarantine custody', async () => {
        const sessionId = 's_test_patch_canonical_with_durable_quarantine';
        const pendingId = 'canonical-with-durable-quarantine';
        const diagnosticId = 'durable-quarantine-diagnostic';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', outboxScope),
            JSON.stringify({
                [sessionId]: [{
                    localId: pendingId,
                    createdAt: 1,
                    text: 'durable quarantine',
                    rawRecord: { role: 'user' },
                    operation: 'replace',
                    request: { v: 1, body: JSON.stringify({ localId: pendingId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
                }],
            }),
        );
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId: pendingId, operation: 'quarantined' }),
        ]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: diagnosticId,
            localId: pendingId,
            createdAt: 1,
            updatedAt: 1,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: outboxScope,
            pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            text: 'diagnostic remains',
            rawRecord: { role: 'user', content: { type: 'text', text: 'diagnostic remains' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            text: 'canonical old',
            rawRecord: { role: 'user', content: { type: 'text', text: 'canonical old' }, meta: {} },
        });
        let requestCalled = false;

        await updatePendingMessageV2({
            sessionId,
            pendingId,
            text: 'canonical new',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => {
                requestCalled = true;
                return new Response('{}', { status: 200 });
            },
        });

        expect(requestCalled).toBe(true);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId: pendingId, operation: 'quarantined' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: diagnosticId, text: 'diagnostic remains' }),
            expect.objectContaining({ id: pendingId, source: 'server_pending', text: 'canonical new' }),
        ]);
    });

    it('keeps the caller-resolved synthetic projection authoritative when its canonical localId is another scoped row id', async () => {
        const sessionId = 's_test_patch_scoped_identity_precedes_raw_id';
        const pendingId = 'scoped-identity-precedes-raw-id';
        const canonicalId = 'scoped-identity-synthetic-projection';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: 'unrelated-local-identity',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: outboxScope,
            text: 'unrelated must remain',
            rawRecord: { role: 'user', content: { type: 'text', text: 'unrelated must remain' }, meta: { owner: 'raw-id-collider' } },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: canonicalId,
            localId: pendingId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: outboxScope,
            text: 'target old',
            rawRecord: { role: 'user', content: { type: 'text', text: 'target old' }, meta: { owner: 'synthetic-target' } },
        });

        let patchBody: unknown;

        await updatePendingMessageV2({
            sessionId,
            pendingId: canonicalId,
            text: 'target new',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async (path, init) => {
                expect(path).toBe(`/v2/sessions/${sessionId}/pending/${pendingId}`);
                patchBody = JSON.parse(String(init?.body));
                return new Response('{}', { status: 200 });
            },
        });

        expect(patchBody).toMatchObject({
            content: {
                t: 'plain',
                v: expect.objectContaining({
                    content: { type: 'text', text: 'target new' },
                    meta: { owner: 'synthetic-target' },
                }),
            },
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: pendingId, localId: 'unrelated-local-identity', text: 'unrelated must remain' }),
            expect.objectContaining({
                id: canonicalId,
                localId: pendingId,
                text: 'target new',
                rawRecord: expect.objectContaining({ meta: { owner: 'synthetic-target' } }),
            }),
        ]);
    });

    it('uses exact-scope canonical server authority before durable and another-scope quarantine fences', async () => {
        const sessionId = 's_test_patch_canonical_precedes_quarantine_fences';
        const pendingId = 'canonical-precedes-quarantine-fences';
        const canonicalId = 'canonical-precedes-quarantine-synthetic';
        const sameScopeDiagnosticId = 'same-scope-diagnostic-stays-fenced';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', outboxScope),
            JSON.stringify({
                [sessionId]: [{
                    localId: pendingId,
                    createdAt: 1,
                    text: 'durable quarantine',
                    rawRecord: { role: 'user' },
                    operation: 'replace',
                    request: { v: 1, body: JSON.stringify({ localId: pendingId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
                }],
            }),
        );
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: 'other-scope-quarantine-owner',
            createdAt: 1,
            updatedAt: 1,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: otherOutboxScope,
            pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            text: 'other scope diagnostic',
            rawRecord: { role: 'user', content: { type: 'text', text: 'other scope diagnostic' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: canonicalId,
            localId: pendingId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: outboxScope,
            text: 'target old',
            rawRecord: { role: 'user', content: { type: 'text', text: 'target old' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: sameScopeDiagnosticId,
            localId: 'same-scope-diagnostic-local',
            createdAt: 3,
            updatedAt: 3,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: outboxScope,
            pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            text: 'same scope diagnostic',
            rawRecord: { role: 'user', content: { type: 'text', text: 'same scope diagnostic' }, meta: {} },
        });
        let requestCount = 0;

        await updatePendingMessageV2({
            sessionId,
            pendingId,
            text: 'target new',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => {
                requestCount += 1;
                return new Response('{}', { status: 200 });
            },
        });
        await expect(updatePendingMessageV2({
            sessionId,
            pendingId: sameScopeDiagnosticId,
            text: 'must remain blocked',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => {
                requestCount += 1;
                return new Response('{}', { status: 200 });
            },
        })).rejects.toThrow('Persisted Pending outbox row is quarantined');

        expect(requestCount).toBe(1);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId: pendingId, operation: 'quarantined' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: pendingId, pendingOutboxScope: otherOutboxScope, text: 'other scope diagnostic' }),
            expect.objectContaining({ id: canonicalId, pendingOutboxScope: outboxScope, text: 'target new' }),
            expect.objectContaining({ id: sameScopeDiagnosticId, text: 'same scope diagnostic' }),
        ]);
    });

    it('fails closed when an exact-scope cancellation is outstanding', async () => {
        const sessionId = 's_test_patch_cancel_fails_closed';
        const pendingId = 'p-cancel';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old', rawRecord,
        });
        (await savePendingOutboxMessage({
            sessionId, localId: pendingId, createdAt: 1, text: 'old', rawRecord, operation: 'cancel',
            request: { v: 1, body: JSON.stringify({ localId: pendingId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope));
        let requestCalled = false;

        await expect(updatePendingMessageV2({
            sessionId, pendingId, text: 'new', encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => { requestCalled = true; return new Response('{}', { status: 200 }); },
        })).rejects.toThrow('Pending message cancellation is outstanding');

        expect(requestCalled).toBe(false);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId: pendingId, operation: 'cancel' }),
        ]);
    });

    it('does not retire cancellation custody that starts while PATCH is in flight', async () => {
        const sessionId = 's_test_patch_cancel_race';
        const pendingId = 'p-race';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old', rawRecord,
        });
        (await savePendingOutboxMessage({
            sessionId, localId: pendingId, createdAt: 1, text: 'old', rawRecord,
            request: { v: 1, body: JSON.stringify({ localId: pendingId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope));
        let patchStarted!: () => void;
        const patchStartedGate = new Promise<void>((resolve) => { patchStarted = resolve; });
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
        let deleteStarted!: () => void;
        const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
        const update = updatePendingMessageV2({
            sessionId,
            pendingId,
            text: 'new',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => {
                patchStarted();
                await patchGate;
                return new Response('{}', { status: 200 });
            },
        });
        await patchStartedGate;
        const deletion = deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => {
                deleteStarted();
                await deleteGate;
                return new Response(null, { status: 500 });
            },
        });
        await deleteStartedGate;
        releasePatch();
        await update;

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId: pendingId, operation: 'cancel' }),
        ]);
        releaseDelete();
        await expect(deletion).rejects.toThrow('Failed to delete pending message (500)');
    });

    it('does not resurrect a row successfully deleted while PATCH is in flight', async () => {
        const sessionId = 's_test_patch_delete_success_race';
        const pendingId = 'p-delete-race';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: pendingId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old', rawRecord,
        });
        let patchStarted!: () => void;
        const patchStartedGate = new Promise<void>((resolve) => { patchStarted = resolve; });
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
        const update = updatePendingMessageV2({
            sessionId,
            pendingId,
            text: 'new',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => {
                patchStarted();
                await patchGate;
                return new Response('{}', { status: 200 });
            },
        });
        await patchStartedGate;

        await deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => new Response(null, { status: 200 }),
        });
        releasePatch();
        await update;

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('preserves outgoing meta fields when existing.rawRecord is missing', async () => {
        const sessionId = 's_test';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId }),
                        metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
                        permissionMode: 'default',
                        modelMode: 'default',
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            text: 'old',
            displayText: 'Old display',
            rawRecord: null,
        });

        let capturedCiphertext: string | null = null;
        const request = async (_path: string, init?: RequestInit) => {
            const parsed = JSON.parse(String(init?.body ?? 'null'));
            capturedCiphertext = typeof parsed?.ciphertext === 'string' ? parsed.ciphertext : null;
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request,
        });

        expect(capturedCiphertext).toEqual(expect.any(String));
        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });
        const decrypted = await sessionEncryption.decryptRaw(capturedCiphertext!);
        expect(decrypted).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'new text' },
        });

        expect(Object.prototype.hasOwnProperty.call(decrypted?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
        expect(typeof decrypted?.meta?.source).toBe('string');
        expect(typeof decrypted?.meta?.sentFrom).toBe('string');
        expect(typeof decrypted?.meta?.permissionMode).toBe('string');
        expect(decrypted?.meta?.displayText).toBe('Old display');
    });

    it('marks encrypted pending update payloads as user messages', async () => {
        const sessionId = 's_test_update_message_role';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: buildSession({ sessionId }) as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            text: 'old',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'old' },
                meta: {},
            },
        });

        const bodies: unknown[] = [];
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return new Response('{}', { status: 200 });
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(expect.objectContaining({
            ciphertext: expect.any(String),
            messageRole: 'user',
        }));
    });

    it('rebuilds rawRecord when existing.rawRecord is not a RawRecord (decrypt-failed placeholder)', async () => {
        const sessionId = 's_test_decrypt_failed_update';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 4 });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId }),
                        metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
                        permissionMode: 'default',
                        modelMode: 'default',
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p_decrypt_failed_1',
            localId: 'p_decrypt_failed_1',
            createdAt: 1,
            updatedAt: 1,
            text: 'old',
            displayText: "Couldn't decrypt this pending message.",
            pendingDecryptFailure: { kind: 'decrypt_failed' },
            // This is the placeholder shape emitted by fetchAndApplyPendingMessagesV2 for decrypt failures.
            rawRecord: { pendingDecryptFailure: { kind: 'decrypt_failed' } },
        });

        let capturedCiphertext: string | null = null;
        const request = async (_path: string, init?: RequestInit) => {
            const parsed = JSON.parse(String(init?.body ?? 'null'));
            capturedCiphertext = typeof parsed?.ciphertext === 'string' ? parsed.ciphertext : null;
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p_decrypt_failed_1',
            text: 'new text',
            encryption,
            request,
        });

        expect(capturedCiphertext).toEqual(expect.any(String));
        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });
        const decrypted = await sessionEncryption.decryptRaw(capturedCiphertext!);
        expect(decrypted).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'new text' },
        });

        // Updating a decrypt-failed placeholder should not preserve the placeholder display text.
        expect(decrypted?.meta?.displayText).toBeUndefined();

        const updated = storage.getState().sessionPending[sessionId]?.messages?.find((m) => m.id === 'p_decrypt_failed_1') ?? null;
        expect(updated?.pendingDecryptFailure).toBeUndefined();
        expect(updated?.displayText).toBeUndefined();
    });

    it('sends plaintext pending updates when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_update';
        const encryption = await createPendingQueueEncryption({ sessionId });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId, overrides: { encryptionMode: 'plain' } }),
                        metadata: { path: '/tmp', host: 'h' },
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            text: 'old',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'old' },
                meta: {},
            },
        });

        let capturedBody: unknown = null;
        const request = async (_path: string, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body ?? 'null'));
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request,
        });

        expect(capturedBody).toEqual(expect.objectContaining({
            content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
            messageRole: 'user',
        }));
        const capturedRecord = capturedBody as { content?: { v?: { content?: { text?: unknown } } } } | null;
        expect(capturedRecord?.content?.v?.content?.text).toBe('new text');
    });

    it('does not inject appendSystemPrompt even when execution-run guidance is enabled in settings', async () => {
        const sessionId = 's_test_guidance';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 6 });

        storage.setState(
            {
                ...storage.getState(),
                settings: {
                    ...storage.getState().settings,
                    experiments: true,
                    featureToggles: {
                        ...(storage.getState().settings as any)?.featureToggles,
                        'execution.runs': true,
                    },
                    executionRunsGuidanceEnabled: true,
                    executionRunsGuidanceMaxChars: 10_000,
                    executionRunsGuidanceEntries: [
                        { id: 'g1', title: 'Rule 1', description: 'Always use execution runs for code reviews.', enabled: true },
                    ],
                },
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId }),
                        metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
                        permissionMode: 'default',
                        modelMode: 'default',
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p_guidance_1',
            localId: 'p_guidance_1',
            createdAt: 1,
            updatedAt: 1,
            text: 'old',
            displayText: 'Old display',
            rawRecord: null,
        });

        let capturedCiphertext: string | null = null;
        const request = async (_path: string, init?: RequestInit) => {
            const parsed = JSON.parse(String(init?.body ?? 'null'));
            capturedCiphertext = typeof parsed?.ciphertext === 'string' ? parsed.ciphertext : null;
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p_guidance_1',
            text: 'new text',
            encryption,
            request,
        });

        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });
        const decrypted = await sessionEncryption.decryptRaw(capturedCiphertext!);
        expect(Object.prototype.hasOwnProperty.call(decrypted?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
    });

    it('still omits appendSystemPrompt when execution runs feature is disabled', async () => {
        const sessionId = 's_test_guidance_disabled';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });

        storage.setState(
            {
                ...storage.getState(),
                settings: {
                    ...storage.getState().settings,
                    experiments: false,
                    featureToggles: {
                        ...(storage.getState().settings as any)?.featureToggles,
                        'execution.runs': false,
                    },
                    executionRunsGuidanceEnabled: true,
                    executionRunsGuidanceMaxChars: 10_000,
                    executionRunsGuidanceEntries: [
                        { id: 'g1', title: 'Rule 1', description: 'Always use execution runs for code reviews.', enabled: true },
                    ],
                },
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId }),
                        metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
                        permissionMode: 'default',
                        modelMode: 'default',
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p_guidance_disabled_1',
            localId: 'p_guidance_disabled_1',
            createdAt: 1,
            updatedAt: 1,
            text: 'old',
            displayText: 'Old display',
            rawRecord: null,
        });

        let capturedCiphertext: string | null = null;
        const request = async (_path: string, init?: RequestInit) => {
            const parsed = JSON.parse(String(init?.body ?? 'null'));
            capturedCiphertext = typeof parsed?.ciphertext === 'string' ? parsed.ciphertext : null;
            return new Response('{}', { status: 200 });
        };

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p_guidance_disabled_1',
            text: 'new text',
            encryption,
            request,
        });

        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });
        const decrypted = await sessionEncryption.decryptRaw(capturedCiphertext!);
        expect(Object.prototype.hasOwnProperty.call(decrypted?.meta ?? {}, 'appendSystemPrompt')).toBe(false);
    });

    it('throws when pending message does not exist', async () => {
        const sessionId = 's_test_not_found';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        await expect(
            updatePendingMessageV2({
                sessionId,
                pendingId: 'missing',
                text: 'new text',
                encryption,
                request: async () => new Response('{}', { status: 200 }),
            }),
        ).rejects.toThrow('Pending message not found');
    });

    it('does not mutate pending text when API update request fails', async () => {
        const sessionId = 's_test_api_fail';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 4 });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId }),
                        metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
                        permissionMode: 'default',
                        modelMode: 'default',
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            text: 'original',
            displayText: 'Original display',
            rawRecord: null,
        });

        await expect(
            updatePendingMessageV2({
                sessionId,
                pendingId: 'p1',
                text: 'new text',
                encryption,
                request: async () => new Response('{}', { status: 500 }),
            }),
        ).rejects.toThrow('Failed to update pending message (500)');

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending).toHaveLength(1);
        expect(pending[0]?.text).toBe('original');
        expect(pending[0]?.displayText).toBe('Original display');
    });

    it('clears pendingDecryptFailure when the user edits a decrypt-failure row', async () => {
        const sessionId = 's_update_pending_decrypt_failure';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 12 });

        storage.setState(
            {
                ...storage.getState(),
                sessions: {
                    ...storage.getState().sessions,
                    [sessionId]: {
                        ...buildSession({ sessionId }),
                        metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
                        permissionMode: 'default',
                        modelMode: 'default',
                    } as Session,
                },
            },
            true,
        );

        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            text: '',
            displayText: 'Failed to decrypt',
            pendingDecryptFailure: { kind: 'decrypt_failed' },
            rawRecord: null,
        });

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'new text',
            encryption,
            request: async () => new Response('{}', { status: 200 }),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending).toHaveLength(1);
        expect(pending[0]?.text).toBe('new text');
        expect(pending[0]?.pendingDecryptFailure).toBeUndefined();
    });

    it('invalidates an older held-decrypt snapshot before applying a successful edit', async () => {
        const sessionId = 's_update_invalidates_held_snapshot';
        const pendingId = 'held-snapshot-pending';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 13 });
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            text: 'before edit',
            rawRecord: { role: 'user', content: { type: 'text', text: 'before edit' }, meta: {} },
        });
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const staleRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            outboxScope,
            isOutboxScopeCurrent: () => true,
            encryption: {
                getSessionEncryption: () => ({
                    decryptRaw: async () => {
                        decryptStarted();
                        await decryptGate;
                        return { role: 'user', content: { type: 'text', text: 'stale snapshot text' }, meta: {} };
                    },
                }),
            },
            request: async () => Response.json({
                pending: [{
                    localId: pendingId,
                    messageRole: 'user',
                    content: { t: 'encrypted', c: 'stale-ciphertext' },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 2,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await decryptStartedGate;

        await updatePendingMessageV2({
            sessionId,
            pendingId,
            text: 'edited text',
            encryption,
            request: async () => new Response('{}', { status: 200 }),
        });
        releaseDecrypt();
        await staleRefresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: pendingId, text: 'edited text' }),
        ]);
    });
});
