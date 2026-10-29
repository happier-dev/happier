import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import {
    loadPendingOutboxForSession,
    savePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import { Encryption } from '@/sync/encryption/encryption';
import { RawRecordSchema, type RawRecord } from "@happier-dev/session-core/raw";
import { HappierStructuredInputV1Schema, RawIngressStructuredInputV1Schema, readAdmittedHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { resolvePendingActivationBanner } from '@/components/sessions/pending/resolvePendingActivationBanner';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { isHostAuthoredInputMeta, readHostFollowInputMeta } from '@/sync/domains/session/input/hostAuthoredInput';

import {
    fetchAndApplyPendingMessagesV2 as fetchAndApplyPendingMessagesV2Impl,
    replayPersistedPendingOutboxForSession,
} from './pendingQueueV2';
import {
    createPendingQueueEncryption,
    encryptRawRecordForPending,
    getSessionEncryptionOrThrow,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

const outboxScope = { serverId: 'server-test', accountId: 'account-test' } as const;
const fetchAndApplyPendingMessagesV2 = (
    params: Omit<Parameters<typeof fetchAndApplyPendingMessagesV2Impl>[0], 'outboxScope'>,
) => fetchAndApplyPendingMessagesV2Impl({
    ...params,
    outboxScope,
    isOutboxScopeCurrent: () => true,
});

describe('pendingQueueV2 decrypt mapping', () => {
    beforeEach(async () => {
        await resetPendingQueueState();
    });

    it.each(['plain', 'encrypted'] as const)('reads retained terminal Follow authority through the stored Pending reader (%s)', async mode => {
        const { OutgoingUserTextRecordSchema } = await import('@/sync/domains/messages/outgoingUserMessage');
        const { resolvePendingMessageContentPresentation } = await import('@/components/sessions/pending/pendingMessageVisualState');
        const sessionId = 'retained-pending-follow';
        const encryption = await createPendingQueueEncryption({ sessionId });
        // Redacted seq267–273 shape: the durable blocked Pending twin still owns
        // the transcript slot. This is stored authority, not a new input request.
        const follow = { v: 1, delivery: 'next_turn', original: { sourceSessionId: 'worker',
            sourceMessage: { localId: 'terminal', seq: 7 } }, event: { kind: 'finished' } } as const;
        const rawRecord = { role: 'user', content: { type: 'text', text: 'Synthetic Follow instructions' }, meta: {
            happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
            happierInputAuthorityV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                permission: { admittedPermissionCeiling: 'default' }, followDeliveryV1: follow },
        } } as const;
        expect(OutgoingUserTextRecordSchema.safeParse(rawRecord).success).toBe(false);
        const content = mode === 'plain' ? { t: 'plain', v: rawRecord } : { t: 'encrypted',
            c: await encryptRawRecordForPending({ encryption, sessionId, rawRecord }) };
        await fetchAndApplyPendingMessagesV2({ sessionId, encryption,
            request: async () => Response.json({ pending: [{ localId: 'follow-original:retained', messageRole: 'user',
                content, hostFollowInput: follow, status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'host_retired_before_dispatch',
                position: 0, createdAt: 1, updatedAt: 1 }] }) });
        const message = storage.getState().sessionPending[sessionId]?.messages[0];
        expect(message).toMatchObject({ text: rawRecord.content.text, source: 'server_pending',
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'host_retired_before_dispatch', pendingHostFollowInput: follow });
        expect(message).not.toHaveProperty('pendingDecryptFailure');
        expect(message).toBeDefined();
        expect(resolvePendingMessageContentPresentation(message!)).toMatchObject({ isHostInput: true, followInput: follow });
        expect(SessionFollowInputV1Schema.safeParse(follow).success).toBe(false);
    });

    it('keeps admitted host identity separate from encrypted authored metadata and withdraws it on refresh', async () => {
        const sessionId = 'pending-host-follow';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const follow = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
            original: { sourceSessionId: 'worker', sourceTurn: { id: 'turn-1', status: 'completed' } },
            event: { kind: 'finished' } });
        const content = { t: 'encrypted', c: await encryptRawRecordForPending({ encryption, sessionId,
            rawRecord: { role: 'user', content: { type: 'text', text: 'Followed source changed' },
                meta: { happierInputRequestV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                    permission: {}, followDeliveryV1: follow },
                    happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' }, hostFollowInput: follow } } }) };
        for (const hostFollowInput of [follow, undefined, { ...follow, v: 99 }]) {
            await fetchAndApplyPendingMessagesV2({ sessionId, encryption,
                request: async () => Response.json({ pending: [{ localId: 'host-input', messageRole: 'user',
                    content, hostFollowInput, status: 'queued', position: 0, createdAt: 1, updatedAt: 1 }] }) });
            const message = storage.getState().sessionPending[sessionId]?.messages[0];
            expect(message?.text).toBe('Followed source changed');
            expect(isHostAuthoredInputMeta(message?.rawRecord.meta, message?.pendingHostFollowInput))
                .toBe(hostFollowInput === follow);
            expect(readHostFollowInputMeta(message?.rawRecord.meta, message?.pendingHostFollowInput))
                .toEqual(hostFollowInput === follow ? follow : null);
        }
    });

    it('accepts only the server recovery projection and withdraws missing or malformed eligibility on refresh', async () => {
        const sessionId = 'recovery-eligibility';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const content = { t: 'encrypted', c: await encryptRawRecordForPending({ encryption, sessionId,
            rawRecord: { role: 'user', content: { type: 'text', text: 'uncertain original' } } }) };
        const row = { localId: 'original', messageRole: 'user', content, status: 'queued',
            deliveryState: 'blocked', deliveryBlockedReason: 'delivery_outcome_uncertain',
            position: 0, createdAt: 1, updatedAt: 1 };
        for (const recovery of [{ canSendAsNew: true }, { canSendAsNew: false }, undefined,
            { canSendAsNew: 'true' }, { canSendAsNew: true, replyProgress: {} }]) {
            await fetchAndApplyPendingMessagesV2({ sessionId, encryption,
                request: async () => Response.json({ pending: [{ ...row, recovery }] }) });
            const message = storage.getState().sessionPending[sessionId]?.messages[0];
            if (recovery && typeof recovery.canSendAsNew === 'boolean' && !('replyProgress' in recovery)) {
                expect(message).toMatchObject({ pendingRecovery: recovery });
            } else {
                expect(message?.pendingRecovery).toBeUndefined();
            }
        }
    });

    it('carries only a valid held exchange root through the real pending refresh and clears it when released', async () => {
        const sessionId = 'held-check-in';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const content = { t: 'encrypted', c: await encryptRawRecordForPending({ encryption, sessionId,
            rawRecord: { role: 'user', content: { type: 'text', text: 'held continuation' } } }) };
        const root = { sessionId: 'original-session', localId: 'original-input' };
        const row = { localId: 'held-input', messageRole: 'user', requestedAction: { v: 1, kind: 'enqueue' },
            content, status: 'queued', position: 0, createdAt: 1, updatedAt: 1 };
        const refresh = (autonomousExchangeRoot: unknown, held = true) => fetchAndApplyPendingMessagesV2({ sessionId, encryption,
            request: async () => Response.json({ pending: [{ ...row, autonomousExchangeRoot,
                ...(held ? { deliveryState: 'blocked', deliveryBlockedReason: 'autonomous_check_in' } : {}) }] }) });
        await refresh(root);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({
            pendingDeliveryBlockedReason: 'autonomous_check_in', pendingAutonomousExchangeRoot: root,
        });
        await refresh({ ...root, localId: '' });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).not.toHaveProperty('pendingAutonomousExchangeRoot');
        await refresh(root, false);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).not.toHaveProperty('pendingAutonomousExchangeRoot');
    });

    it('keeps an unopened encrypted row loading until its Session reader arrives, then distinguishes a genuine decrypt failure', async () => {
        const sessionId = 'reader-loading';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const content = { t: 'encrypted', c: await encryptRawRecordForPending({ encryption, sessionId,
            rawRecord: { role: 'user', content: { type: 'text', text: 'original queued input' } } }) };
        const request = async () => Response.json({ pending: [{ localId: 'original', messageRole: 'user',
            content, status: 'queued', position: 0, createdAt: 1, updatedAt: 1 }] });
        await fetchAndApplyPendingMessagesV2({ sessionId, encryption: null, request });
        expect(storage.getState().sessionPending[sessionId]?.messages).toMatchObject([
            { localId: 'original', pendingDecryption: { kind: 'loading' }, pendingDeliveryStatus: 'server_queued' },
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).not.toHaveProperty('pendingDecryptFailure');
        await fetchAndApplyPendingMessagesV2({ sessionId, encryption, request });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({ text: 'original queued input' });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).not.toHaveProperty('pendingDecryption');
        await fetchAndApplyPendingMessagesV2({ sessionId, encryption: null, request });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({ text: 'original queued input' });
        await fetchAndApplyPendingMessagesV2({ sessionId, encryption,
            request: async () => Response.json({ pending: [{ localId: 'bad', content: { t: 'encrypted', c: 'invalid' },
                status: 'queued', position: 0, createdAt: 1, updatedAt: 1 }] }) });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({ pendingDecryptFailure: { kind: 'decrypt_failed' } });
    });

    it.each(['managed_power_required', 'resume_not_requested'] as const)('carries the canonical %s hold through queue refresh into its recovery presentation', async reason => {
        const sessionId = 'stopped-managed';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const content = { t: 'encrypted', c: await encryptRawRecordForPending({ encryption, sessionId,
            rawRecord: { role: 'user', content: { type: 'text', text: 'accepted input' } } }) };
        const row = { localId: 'held-input', messageRole: 'user', requestedAction: { v: 1, kind: 'enqueue' },
            content, status: 'queued', deliveryStatus: { status: 'queued' }, position: 0, createdAt: 1, updatedAt: 1 };
        let holdReason: string | undefined = reason;
        const refresh = () => fetchAndApplyPendingMessagesV2({ sessionId, encryption,
            request: async () => Response.json({ pending: [{ ...row, ...(holdReason ? { activationHoldReason: holdReason } : {}) }] }) });
        await refresh();
        const pendingMessages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pendingMessages).toMatchObject([{ localId: 'held-input', pendingDeliveryStatus: 'server_queued',
            pendingActivationHoldReason: reason }]);
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 0, active: false,
            machineReachable: false, canWrite: true, pendingMessages })).toMatchObject({
            kind: 'queued_offline', holdReason: reason,
            primaryAction: reason === 'managed_power_required' ? null : 'process_when_online',
        });
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 0, active: false,
            machineReachable: true, canWrite: true, pendingMessages })).toMatchObject({ kind: 'queued', primaryAction: 'resume' });
        const unknown = { kind: 'unknown' as const, inputCustody: 'queued' as const,
            canWithdraw: true, canRetryAgentStart: false, canRequestWake: false, canResumeRuntime: false };
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 0, active: false,
            machineReachable: false, canWrite: true, pendingMessages, managedWakeProjection: unknown }))
            .toMatchObject({ holdReason: reason });
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 0, active: false,
            machineReachable: false, canWrite: true, pendingMessages, managedWakeProjection: { ...unknown, kind: 'starting' } }))
            .toMatchObject({ managedWakeProjection: { kind: 'starting' } });
        expect(resolvePendingActivationBanner({ authorization: null, activeAt: 0, active: false,
            machineReachable: false, canWrite: true,
            pendingMessages: pendingMessages.map(message => ({ ...message, pendingDeliveryStatus: 'server_delivering' as const })) })).toBeNull();
        holdReason = undefined;
        await refresh();
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).not.toHaveProperty('pendingActivationHoldReason');
        holdReason = 'newer_unknown_diagnostic';
        await refresh();
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).not.toHaveProperty('pendingActivationHoldReason');
    });

    it('retains decrypted rows that cannot be coerced to a RawRecord user-text message as explicit failures', async () => {
        const sessionId = 's_test';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const sessionEncryption = getSessionEncryptionOrThrow({ encryption, sessionId });

        const valid: RawRecord = {
            role: 'user',
            content: { type: 'text', text: 'ok' },
            meta: { displayText: 'OK' },
        };
        const validCiphertext = await encryptRawRecordForPending({
            encryption,
            sessionId,
            rawRecord: valid,
        });

        const invalidCiphertext = await sessionEncryption.encryptRaw({
            content: { text: 'should-not-render' },
            meta: { displayText: 'bad' },
        });

        const responseJson = {
            pending: [
                {
                    localId: 'a',
                    content: { t: 'encrypted', c: validCiphertext },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    localId: 'b',
                    content: { t: 'encrypted', c: invalidCiphertext },
                    status: 'queued',
                    position: 1,
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
        };

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify(responseJson), { status: 200 }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((m) => m.localId)).toEqual(['a', 'b']);
        expect(messages[0]?.text).toBe('ok');
        expect(messages[0]?.displayText).toBe('OK');
        expect(messages[1]).toMatchObject({ pendingDecryptFailure: { kind: 'decrypt_failed' } });
    });

    it('projects a queued attachment-only media row instead of a false decrypt failure', async () => {
        const sessionId = 's_attachment_only_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const admittedImageAttachment = {
            v: 1,
            instanceId: 'attachment-media-1',
            attachment: { pluginId: 'acme.media', localId: 'image' },
            key: 'hero-image',
            value: { alt: 'A mountain lake' },
            presentation: { label: 'Hero image', typeLabel: 'Image' },
            content: {
                kind: 'sessionMedia',
                mediaId: 'media-1',
            },
        };
        // Pending enqueue persists the finalized prepare response, not its
        // draft staged-media claim. Verify the real stored-input boundary
        // before asking the row projection to retain this attachment-only turn.
        const admittedRecord = RawRecordSchema.parse({
            role: 'user',
            content: { type: 'text', text: '' },
            meta: {
                happierStructuredInputV1: HappierStructuredInputV1Schema.parse({
                    v: 1,
                    composerAttachments: [admittedImageAttachment],
                }),
            },
        });
        expect(readAdmittedHappierStructuredInputV1FromMeta(admittedRecord.meta)).toMatchObject({
            status: 'admitted',
            structuredInput: { composerAttachments: [admittedImageAttachment] },
        });
        const draftRecord = RawRecordSchema.parse({
            role: 'user', content: { type: 'text', text: '' },
            meta: { happierStructuredInputV1: RawIngressStructuredInputV1Schema.parse({
                v: 1, composerAttachments: [{ ...admittedImageAttachment, content: {
                    kind: 'stagedMedia', handle: {
                        v: 1, id: 'stage-1', executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                        owner: { pluginId: 'acme.media', localId: 'image' }, mediaKind: 'image',
                        mimeType: 'image/png', name: 'hero.png', sizeBytes: 42, sha256: 'a'.repeat(64),
                    },
                } }],
            }) },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => Response.json({
                pending: [
                    {
                        localId: 'media-only',
                        content: {
                            t: 'plain',
                            v: admittedRecord,
                        },
                        status: 'queued', position: 0, createdAt: 1, updatedAt: 1,
                    },
                    {
                        localId: 'truly-blank',
                        content: {
                            t: 'plain',
                            v: { role: 'user', content: { type: 'text', text: '   ' }, meta: {} },
                        },
                        status: 'queued', position: 1, createdAt: 2, updatedAt: 2,
                    },
                    {
                        localId: 'unadmitted-draft', content: { t: 'plain', v: draftRecord },
                        status: 'queued', position: 2, createdAt: 3, updatedAt: 3,
                    },
                ],
            }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((m) => m.localId)).toEqual(['media-only', 'truly-blank', 'unadmitted-draft']);
        // The attachment-only turn is a real queued message; losing its rawRecord loses the
        // selected media and makes the row unsendable.
        expect(messages[0]?.pendingDecryptFailure).toBeUndefined();
        expect(messages[0]?.text).toBe('');
        expect(messages[0]?.rawRecord).toMatchObject({
            meta: { happierStructuredInputV1: { composerAttachments: [admittedImageAttachment] } },
        });
        // A blank row carrying no submittable selection stays an explicit failure.
        expect(messages[1]).toMatchObject({ pendingDecryptFailure: { kind: 'decrypt_failed' } });
        expect(messages[2]).toMatchObject({ pendingDecryptFailure: { kind: 'decrypt_failed' } });
    });

    it('maps plaintext pending rows without decrypting', async () => {
        const sessionId = 's_plain_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });

        const responseJson = {
            pending: [
                {
                    localId: 'a',
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'ok' } } },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        };

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => new Response(JSON.stringify(responseJson), { status: 200 }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((m) => m.localId)).toEqual(['a']);
        expect(messages[0]?.text).toBe('ok');
    });

    it('projects the server-owned requested action and marks malformed non-null actions', async () => {
        const sessionId = 's_pending_actions';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () => Response.json({
                pending: [
                    {
                        localId: 'send-now',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send' } } },
                        requestedAction: { v: 1, kind: 'send_now' },
                        status: 'queued', position: 0, createdAt: 1, updatedAt: 1,
                    },
                    {
                        localId: 'malformed',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'bad' } } },
                        requestedActionMalformed: true,
                        status: 'queued',
                        deliveryStatus: { status: 'blocked', reason: 'unsupported_action' },
                        position: 1, createdAt: 2, updatedAt: 2,
                    },
                ],
            }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages[0]).toMatchObject({ pendingRequestedAction: { v: 1, kind: 'send_now' } });
        expect(messages[1]).toMatchObject({
            pendingRequestedActionMalformed: true,
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'unsupported_action',
        });
        expect(messages[1]?.pendingRequestedAction).toBeUndefined();
    });

    it('maps provider-owned rows from server delivery state without local accepted delivery metadata', async () => {
        const sessionId = 's_additive_delivery_state_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'provider-owned',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'provider owned' } } },
                                status: 'queued',
                                deliveryState: 'delivering',
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                localId: 'blocked-additive',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'blocked additive' } } },
                                status: 'queued',
                                deliveryState: 'blocked',
                                deliveryBlockedReason: 'payload_too_large',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((message) => message.localId)).toEqual(['provider-owned', 'blocked-additive']);
        expect(messages.map((message) => message.pendingDeliveryStatus)).toEqual(['server_delivering', 'blocked']);
        expect(messages.map((message) => message.deliveryStatus)).toEqual([undefined, undefined]);
        expect(messages[1]?.pendingDeliveryBlockedReason).toBe('payload_too_large');
    });

    it('prefers typed delivery status while retaining raw-field fallback', async () => {
        const sessionId = 's_typed_delivery_status_pending';
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'typed-delivering',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'typed delivering' } } },
                                status: 'queued',
                                deliveryState: 'blocked',
                                deliveryBlockedReason: 'payload_too_large',
                                deliveryStatus: { status: 'delivering', detail: 'custody_observed' },
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                localId: 'raw-blocked',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'raw blocked' } } },
                                status: 'queued',
                                deliveryState: 'blocked',
                                deliveryBlockedReason: 'runtime_config_blocked',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                            },
                            {
                                localId: 'typed-external-handoff',
                                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'typed external handoff' } } },
                                status: 'queued',
                                deliveryState: 'external_handoff',
                                deliveryStatus: { status: 'external_handoff' },
                                position: 2,
                                createdAt: 3,
                                updatedAt: 3,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.map((message) => message.localId)).toEqual(['typed-delivering', 'raw-blocked', 'typed-external-handoff']);
        expect(messages.map((message) => message.pendingDeliveryStatus)).toEqual(['server_delivering', 'blocked', 'external_handoff']);
        expect(messages[0]?.pendingDeliveryDetail).toBe('custody_observed');
        expect(messages[0]?.pendingDeliveryBlockedReason).toBeUndefined();
        expect(messages[1]?.pendingDeliveryBlockedReason).toBe('runtime_config_blocked');
    });

    it('skips malformed pending rows and keeps valid rows while retaining decrypt failures explicitly', async () => {
        const sessionId = 's_test_mixed';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 9 });

        const queuedRecord: RawRecord = {
            role: 'user',
            content: { type: 'text', text: 'queued' },
        };
        const discardedRecord: RawRecord = {
            role: 'user',
            content: { type: 'text', text: 'discarded' },
        };

        const queuedCiphertext = await encryptRawRecordForPending({
            encryption,
            sessionId,
            rawRecord: queuedRecord,
        });
        const discardedCiphertext = await encryptRawRecordForPending({
            encryption,
            sessionId,
            rawRecord: discardedRecord,
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            { status: 'queued', position: 0, createdAt: 1, updatedAt: 1 }, // malformed (missing localId/content)
                            {
                                localId: 'queued-valid',
                                content: { t: 'encrypted', c: queuedCiphertext },
                                status: 'queued',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                            },
                            {
                                localId: 'queued-bad-cipher',
                                content: { t: 'encrypted', c: 'not-a-valid-ciphertext' },
                                status: 'queued',
                                position: 2,
                                createdAt: 3,
                                updatedAt: 3,
                            },
                            {
                                localId: 'discarded-valid',
                                content: { t: 'encrypted', c: discardedCiphertext },
                                status: 'discarded',
                                position: 3,
                                createdAt: 4,
                                updatedAt: 4,
                                discardedAt: 5,
                                discardedReason: 'switch_to_local',
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['queued-valid', 'queued-bad-cipher']);
        expect(pendingState?.messages[0]?.text).toBe('queued');
        expect(pendingState?.messages[1]).toMatchObject({ pendingDecryptFailure: { kind: 'decrypt_failed' } });
        expect(pendingState?.discarded.map((message) => message.localId)).toEqual(['discarded-valid']);
        expect(pendingState?.discarded[0]?.discardedReason).toBe('switch_to_local');
    });

    it('retains queued and discarded rows with an explicit failure state when decrypt fails', async () => {
        const sessionId = 's_test_decrypt_failures';
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 11 });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'queued-bad-cipher',
                                content: { t: 'encrypted', c: 'not-a-valid-ciphertext' },
                                status: 'queued',
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                            {
                                localId: 'discarded-bad-cipher',
                                content: { t: 'encrypted', c: 'not-a-valid-ciphertext' },
                                status: 'discarded',
                                position: 1,
                                createdAt: 2,
                                updatedAt: 2,
                                discardedAt: 3,
                                discardedReason: 'manual',
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['queued-bad-cipher']);
        expect(pendingState?.discarded.map((message) => message.localId)).toEqual(['discarded-bad-cipher']);

        const queuedFailure = pendingState?.messages[0] as (typeof pendingState.messages)[number] & {
            pendingDecryptFailure?: { kind: string };
        };
        const discardedFailure = pendingState?.discarded[0] as (typeof pendingState.discarded)[number] & {
            pendingDecryptFailure?: { kind: string };
        };

        expect(queuedFailure?.displayText).toBeTruthy();
        expect(queuedFailure?.text).toBe('');
        expect(queuedFailure?.pendingDecryptFailure).toEqual({ kind: 'decrypt_failed' });
        expect(discardedFailure?.displayText).toBeTruthy();
        expect(discardedFailure?.text).toBe('');
        expect(discardedFailure?.pendingDecryptFailure).toEqual({ kind: 'decrypt_failed' });
    });

    it('hides a send-as-new idempotency tombstone returned by an older server', async () => {
        const sessionId = 's_send_as_new_legacy_tombstone';

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({
                pending: [
                    {
                        localId: 'replacement',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send me' } } },
                        status: 'queued',
                        position: 0,
                        createdAt: 2,
                        updatedAt: 2,
                    },
                    {
                        localId: 'original',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send me' } } },
                        status: 'discarded',
                        position: 0,
                        createdAt: 1,
                        updatedAt: 2,
                        discardedAt: 2,
                        discardedReason: 'resent_as_new',
                    },
                ],
            }),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['replacement']);
        expect(pendingState?.discarded).toEqual([]);
    });

    it('retains encrypted pending rows as loading when session encryption is unavailable', async () => {
        const sessionId = 's_missing_session_encryption';
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request: async () =>
                new Response(
                    JSON.stringify({
                        pending: [
                            {
                                localId: 'queued-missing-key',
                                content: { t: 'encrypted', c: 'any-ciphertext' },
                                status: 'queued',
                                position: 0,
                                createdAt: 1,
                                updatedAt: 1,
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages.map((message) => message.localId)).toEqual(['queued-missing-key']);
        expect(pendingState?.messages[0]).toMatchObject({ pendingDecryption: { kind: 'loading' } });
        expect(pendingState?.messages[0]).not.toHaveProperty('pendingDecryptFailure');
    });

    it('treats a same-ID server row with malformed content as persisted and retires enqueue custody into an explicit failure', async () => {
        const sessionId = 's_malformed_server_row_retires_custody';
        const localId = 'malformed-server-row';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'local custody' }, meta: {} };
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 1,
            text: 'local custody',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }),
            },
        }, outboxScope));
        replayPersistedPendingOutboxForSession(sessionId, outboxScope);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({ pending: [{
                localId,
                content: { t: 'future-content-envelope', value: 'unsupported' },
                status: 'queued',
                position: 0,
                createdAt: 2,
                updatedAt: 2,
            }] }),
        });

        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDecryptFailure: { kind: 'decrypt_failed' },
            }),
        ]);
    });
});
