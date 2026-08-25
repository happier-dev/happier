import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { loadPendingOutboxForSession, savePendingOutboxMessage } from '@/sync/domains/state/pendingOutboxPersistence';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    deletePendingMessageV2 as deletePendingMessageV2Impl,
    fetchAndApplyPendingMessagesV2,
    markPendingDeliveryHandledV2 as markPendingDeliveryHandledV2Impl,
    replayPersistedPendingOutboxForSession,
    updatePendingMessageV2 as updatePendingMessageV2Impl,
    updatePendingRequestedActionV2 as updatePendingRequestedActionV2Impl,
} from './pendingQueueV2';
import {
    buildSession,
    createPendingQueueEncryption,
    getSessionEncryptionOrThrow,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

describe('pendingQueueV2 updatePendingMessageV2', () => {
    const outboxScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const updatePendingMessageV2 = (
        params: Omit<Parameters<typeof updatePendingMessageV2Impl>[0], 'outboxScope'>,
    ) => updatePendingMessageV2Impl({ ...params, outboxScope });
    const deletePendingMessageV2 = (
        params: Omit<Parameters<typeof deletePendingMessageV2Impl>[0], 'outboxScope'>,
    ) => deletePendingMessageV2Impl({ ...params, outboxScope });
    const updatePendingRequestedActionV2 = (
        params: Omit<Parameters<typeof updatePendingRequestedActionV2Impl>[0], 'outboxScope'>,
    ) => updatePendingRequestedActionV2Impl({ ...params, outboxScope });
    const markPendingDeliveryHandledV2 = (
        params: Omit<Parameters<typeof markPendingDeliveryHandledV2Impl>[0], 'outboxScope'>,
    ) => markPendingDeliveryHandledV2Impl({ ...params, outboxScope });

    beforeEach(() => {
        resetPendingQueueState();
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

    it('serializes an edited contentless composer attachment selection in the pending PATCH', async () => {
        const sessionId = 's_test_pending_edit_composer_attachment';
        const mention = {
            kind: 'happier.file',
            ref: 'file:src/index.ts',
            token: '@src/index.ts',
            start: 0,
            end: 13,
        } as const;
        const originalAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const editedAttachment = {
            ...originalAttachment,
            value: { issueId: 43 },
            presentation: { label: 'Issue #43', typeLabel: 'Issue' },
        } as const;
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: '@src/index.ts old text' },
            meta: {
                otherMetadata: 'preserved',
                happierStructuredInputV1: {
                    v: 1,
                    mentions: [mention],
                    composerAttachments: [originalAttachment],
                },
            },
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: '@src/index.ts old text', rawRecord,
        });

        let body: unknown = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: '@src/index.ts edited text',
            structuredInput: {
                v: 1,
                mentions: [mention],
                composerAttachments: [editedAttachment],
            },
            encryption: null,
            request: async (_path, init) => {
                body = JSON.parse(String(init?.body ?? 'null'));
                return new Response(null, { status: 204 });
            },
        });

        expect(body).toEqual({
            content: {
                t: 'plain',
                v: expect.objectContaining({
                    content: { type: 'text', text: '@src/index.ts edited text' },
                    meta: {
                        otherMetadata: 'preserved',
                        happierStructuredInputV1: {
                            v: 1,
                            mentions: [mention],
                            composerAttachments: [editedAttachment],
                        },
                    },
                }),
            },
            messageRole: 'user',
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                text: '@src/index.ts edited text',
                rawRecord: expect.objectContaining({
                    meta: expect.objectContaining({
                        happierStructuredInputV1: {
                            v: 1,
                            mentions: [mention],
                            composerAttachments: [editedAttachment],
                        },
                    }),
                }),
            }),
        ]);
    });

    it('atomically replaces pending structured references with the current composer snapshot', async () => {
        const sessionId = 's_test_pending_edit_structured_references';
        const previousMention = {
            kind: 'happier.file',
            ref: 'file:src/old.ts',
            token: '@src/old.ts',
            start: 0,
            end: 11,
        } as const;
        const currentMention = {
            kind: 'happier.file',
            ref: 'file:src/current.ts',
            token: '@src/current.ts',
            start: 0,
            end: 15,
        } as const;
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const text = '@src/current.ts edited text';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: '@src/old.ts old text',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: '@src/old.ts old text' },
                meta: {
                    happierStructuredInputV1: {
                        v: 1,
                        mentions: [previousMention],
                        composerAttachments: [attachment],
                    },
                },
            },
        });

        let body: unknown = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text,
            structuredInput: {
                v: 1,
                mentions: [currentMention],
                composerAttachments: [attachment],
            },
            encryption: null,
            request: async (_path, init) => {
                body = JSON.parse(String(init?.body ?? 'null'));
                return new Response(null, { status: 204 });
            },
        });

        expect(body).toEqual(expect.objectContaining({
            content: expect.objectContaining({
                t: 'plain',
                v: expect.objectContaining({
                    content: { type: 'text', text },
                    meta: {
                        happierStructuredInputV1: {
                            v: 1,
                            mentions: [currentMention],
                            composerAttachments: [attachment],
                        },
                    },
                }),
            }),
        }));
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                rawRecord: expect.objectContaining({
                    meta: {
                        happierStructuredInputV1: {
                            v: 1,
                            mentions: [currentMention],
                            composerAttachments: [attachment],
                        },
                    },
                }),
            }),
        ]);
    });

    it('removes pending structured references when the current composer snapshot removes them', async () => {
        const sessionId = 's_test_pending_edit_structured_references_remove';
        const mention = {
            kind: 'happier.file',
            ref: 'file:src/index.ts',
            token: '@src/index.ts',
            start: 0,
            end: 13,
        } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: '@src/index.ts old text',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: '@src/index.ts old text' },
                meta: {
                    otherMetadata: 'preserved',
                    happierStructuredInputV1: { v: 1, mentions: [mention] },
                },
            },
        });

        let body: unknown = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'plain edited text',
            structuredInput: { v: 1 },
            encryption: null,
            request: async (_path, init) => {
                body = JSON.parse(String(init?.body ?? 'null'));
                return new Response(null, { status: 204 });
            },
        });

        expect(body).toEqual(expect.objectContaining({
            content: expect.objectContaining({
                t: 'plain',
                v: expect.objectContaining({
                    content: { type: 'text', text: 'plain edited text' },
                    meta: { otherMetadata: 'preserved' },
                }),
            }),
        }));
        expect((body as { content: { v: { meta: Record<string, unknown> } } }).content.v.meta)
            .not.toHaveProperty('happierStructuredInputV1');
    });

    it('carries an edited contentless attachment selection through the existing encrypted content envelope', async () => {
        const sessionId = 's_test_pending_edit_composer_attachment_encrypted';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const attachment = {
            v: 1,
            instanceId: 'issue-43',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '43',
            value: { issueId: 43 },
            presentation: { label: 'Issue #43', typeLabel: 'Issue' },
        } as const;
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old text',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'old text' },
                meta: {},
            },
        });

        let ciphertext: string | null = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'edited text',
            structuredInput: { v: 1, composerAttachments: [attachment] },
            encryption,
            request: async (_path, init) => {
                const body = JSON.parse(String(init?.body ?? 'null'));
                ciphertext = typeof body?.ciphertext === 'string' ? body.ciphertext : null;
                return new Response(null, { status: 204 });
            },
        });

        expect(ciphertext).toEqual(expect.any(String));
        await expect(getSessionEncryptionOrThrow({ encryption, sessionId }).decryptRaw(ciphertext!))
            .resolves.toMatchObject({
                content: { type: 'text', text: 'edited text' },
                meta: {
                    happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
                },
            });
    });

    it('persists the exact daemon-admitted SessionMedia attachment through the sole Pending writer', async () => {
        const sessionId = 's_test_pending_edit_composer_attachment_staged_media';
        const admittedAttachment = {
            v: 1,
            instanceId: 'issue-44',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '44',
            value: { issueId: 44 },
            presentation: { label: 'Issue #44', typeLabel: 'Issue' },
            content: {
                kind: 'sessionMedia',
                mediaId: 'media-44',
            },
        } as const;
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'old text' },
            meta: {
                happierStructuredInputV1: { v: 1, composerAttachments: [admittedAttachment] },
            },
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old text', rawRecord,
        });

        let body: unknown = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'edited text',
            structuredInput: { v: 1, composerAttachments: [admittedAttachment] },
            encryption: null,
            request: async (_path, init) => {
                body = JSON.parse(String(init?.body ?? 'null'));
                return new Response(null, { status: 204 });
            },
        });

        expect((body as { content: { v: { meta: Record<string, unknown> } } }).content.v.meta)
            .toEqual({
                happierStructuredInputV1: { v: 1, composerAttachments: [admittedAttachment] },
            });
    });

    it('removes only the deleted composer attachment when PATCHing a pending edit', async () => {
        const sessionId = 's_test_pending_edit_composer_attachment_delete';
        const removedAttachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const retainedAttachment = {
            v: 1,
            instanceId: 'issue-43',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '43',
            value: { issueId: 43 },
            presentation: { label: 'Issue #43', typeLabel: 'Issue' },
        } as const;
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'old text' },
            meta: {
                otherMetadata: 'preserved',
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments: [removedAttachment, retainedAttachment],
                },
            },
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old text', rawRecord,
        });

        let body: unknown = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'edited text',
            structuredInput: { v: 1, composerAttachments: [retainedAttachment] },
            encryption: null,
            request: async (_path, init) => {
                body = JSON.parse(String(init?.body ?? 'null'));
                return new Response(null, { status: 204 });
            },
        });

        expect(body).toEqual(expect.objectContaining({
            content: expect.objectContaining({
                t: 'plain',
                v: expect.objectContaining({
                    meta: {
                        otherMetadata: 'preserved',
                        happierStructuredInputV1: {
                            v: 1,
                            composerAttachments: [retainedAttachment],
                        },
                    },
                }),
            }),
        }));
    });

    it('removes the structured envelope when a pending edit deletes its last composer attachment', async () => {
        const sessionId = 's_test_pending_edit_composer_attachment_delete_last';
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old text',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'old text' },
                meta: {
                    otherMetadata: 'preserved',
                    happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
                },
            },
        });

        let body: unknown = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'edited text',
            structuredInput: { v: 1 },
            encryption: null,
            request: async (_path, init) => {
                body = JSON.parse(String(init?.body ?? 'null'));
                return new Response(null, { status: 204 });
            },
        });

        expect(body).toEqual(expect.objectContaining({
            content: expect.objectContaining({
                t: 'plain',
                v: expect.objectContaining({
                    content: { type: 'text', text: 'edited text' },
                    meta: { otherMetadata: 'preserved' },
                }),
            }),
        }));
        expect((body as { content: { v: { meta: Record<string, unknown> } } }).content.v.meta)
            .not.toHaveProperty('happierStructuredInputV1');
    });

    it('keeps the existing structured attachment selection for an ordinary text-only pending update', async () => {
        const sessionId = 's_test_pending_edit_text_only';
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'old text' },
            meta: { happierStructuredInputV1: { v: 1, composerAttachments: [attachment] } },
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old text', rawRecord,
        });

        let body: unknown = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'edited text',
            encryption: null,
            request: async (_path, init) => {
                body = JSON.parse(String(init?.body ?? 'null'));
                return new Response(null, { status: 204 });
            },
        });

        expect(body).toEqual(expect.objectContaining({
            content: expect.objectContaining({
                t: 'plain',
                v: expect.objectContaining({
                    meta: { happierStructuredInputV1: { v: 1, composerAttachments: [attachment] } },
                }),
            }),
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

    it('rotates one canonical Pending projection only after the server confirms its replacement localId', async () => {
        const sessionId = 's_test_pending_local_id_rotation';
        const localId = 'pending-local-id-original';
        const replacementLocalId = 'pending-local-id-replacement';
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'original' },
            meta: {},
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'server-row-id',
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'original',
            rawRecord,
        });

        let requestBody: Record<string, unknown> | null = null;
        await updatePendingMessageV2({
            sessionId,
            pendingId: 'server-row-id',
            text: 'prepared edit',
            replacementLocalId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async (_path, init) => {
                requestBody = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
                return Response.json({ ok: true, localId: replacementLocalId });
            },
        });

        expect(requestBody).toMatchObject({
            replacementLocalId,
            replacementMutationFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'server-row-id',
                localId: replacementLocalId,
                text: 'prepared edit',
            }),
        ]);
    });

    it('reuses the admitted mutation fingerprint when an exact localId-rotation response is lost', async () => {
        const sessionId = 's_test_pending_local_id_rotation_response_lost';
        const localId = 'pending-local-id-original';
        const replacementLocalId = 'pending-local-id-replacement';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'server-row-id',
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'original',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'original' },
                meta: {},
            },
        });

        const requestBodies: Record<string, unknown>[] = [];
        const request = async (_path: string, init?: RequestInit) => {
            requestBodies.push(JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>);
            if (requestBodies.length === 1) throw new Error('response lost after server admission');
            return Response.json({ ok: true, localId: replacementLocalId });
        };

        await expect(updatePendingMessageV2({
            sessionId,
            pendingId: 'server-row-id',
            text: 'prepared edit',
            replacementLocalId,
            encryption: null,
            request,
        })).rejects.toThrow('response lost after server admission');

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'server-row-id',
            text: 'prepared edit',
            replacementLocalId,
            encryption: null,
            request,
        });

        expect(requestBodies).toHaveLength(2);
        expect(requestBodies[0]).toMatchObject({
            replacementLocalId,
            replacementMutationFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        });
        expect(requestBodies[1]?.replacementMutationFingerprint)
            .toBe(requestBodies[0]?.replacementMutationFingerprint);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'server-row-id',
                localId: replacementLocalId,
                text: 'prepared edit',
            }),
        ]);
    });

    it('leaves the canonical Pending projection unchanged when a replacement PATCH lacks confirmation', async () => {
        const sessionId = 's_test_pending_local_id_rotation_unconfirmed';
        const localId = 'pending-local-id-original';
        const replacementLocalId = 'pending-local-id-replacement';
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'original' },
            meta: {},
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'server-row-id',
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'original',
            rawRecord,
        });

        await expect(updatePendingMessageV2({
            sessionId,
            pendingId: 'server-row-id',
            text: 'prepared edit',
            replacementLocalId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => Response.json({ ok: true }),
        })).rejects.toMatchObject({
            code: 'pending_message_mutation_protocol_unsupported',
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'server-row-id',
                localId,
                text: 'original',
            }),
        ]);
    });

    it('does not let an older held-decrypt snapshot overwrite a successful edit', async () => {
        const sessionId = 's_test_held_decrypt_edit';
        const baseEncryption = await createPendingQueueEncryption({ sessionId, seedByte: 13 });
        const sessionEncryption = getSessionEncryptionOrThrow({ encryption: baseEncryption, sessionId });
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'older server text' }, meta: {} };
        const ciphertext = await sessionEncryption.encryptRawRecord(rawRecord);
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: (record: Parameters<typeof sessionEncryption.encryptRawRecord>[0]) =>
                    sessionEncryption.encryptRawRecord(record),
                decryptRaw: async (value: string) => {
                    decryptStarted();
                    await decryptGate;
                    return sessionEncryption.decryptRaw(value);
                },
            }),
        } as unknown as typeof baseEncryption;

        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'older server text', rawRecord,
        });

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId: 'p1', content: { t: 'encrypted', c: ciphertext }, messageRole: 'user',
                    status: 'queued', position: 0, createdAt: 1, updatedAt: 2,
                    discardedAt: null, discardedReason: null,
                }],
            }),
        });
        await decryptStartedGate;

        await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'edited text',
            encryption,
            request: async () => new Response('{}', { status: 200 }),
        });
        releaseDecrypt();
        await refresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: 'p1', text: 'edited text' }),
        ]);
    });

    it('retires exact-scope enqueue custody after a successful server PATCH', async () => {
        const sessionId = 's_test_patch_retires_enqueue';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old', rawRecord,
        });
        savePendingOutboxMessage({
            sessionId, localId: 'p1', createdAt: 1, text: 'old', rawRecord, operation: 'enqueue',
            request: { v: 1, body: JSON.stringify({ localId: 'p1', content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope);

        await updatePendingMessageV2({
            sessionId, pendingId: 'p1', text: 'edited', encryption,
            request: async () => new Response(null, { status: 204 }),
        });

        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ source: 'server_pending', text: 'edited' }),
        ]);
    });

    it('retires content PATCH enqueue custody without inventing server snapshot provenance', async () => {
        const sessionId = 's_test_content_patch_hands_off_custody';
        const localId = 'content-patch-hands-off-custody';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'queued' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'queued', rawRecord, operation: 'enqueue',
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'local_outbound', deliveryStatus: 'queued', sendState: 'unconfirmed',
            pendingOutboxScope: outboxScope, pendingOutboxOperation: 'enqueue', text: 'queued', rawRecord,
        });

        await updatePendingMessageV2({
            sessionId, pendingId: localId, text: 'edited', encryption,
            request: async () => new Response(null, { status: 204 }),
        });

        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                sendState: undefined,
                pendingOutboxOperation: undefined,
                text: 'edited',
            }),
        ]);
        let deleteRequests = 0;
        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                deleteRequests += 1;
                return new Response(null, { status: 500 });
            },
        })).rejects.toThrow('Failed to delete pending message');
        expect(deleteRequests).toBe(1);
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);
    });

    it('updates the canonical server projection when a same-local-id quarantine diagnostic is ordered first', async () => {
        const sessionId = 's_test_patch_skips_quarantine_diagnostic';
        const localId = 'patch-skips-quarantine-diagnostic';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const serverRawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old server' }, meta: {} };
        const diagnosticRawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'diagnostic' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'pending-outbox-quarantine:diagnostic-first', localId, createdAt: 1, updatedAt: 1,
            source: 'local_outbound', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'unknown',
            pendingDeliveryBlockedReasonRaw: 'unsupported persisted operation',
            text: 'diagnostic', rawRecord: diagnosticRawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 2, updatedAt: 2,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old server', rawRecord: serverRawRecord,
        });

        await updatePendingMessageV2({
            sessionId, pendingId: localId, text: 'edited server', encryption,
            request: async () => new Response(null, { status: 204 }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'pending-outbox-quarantine:diagnostic-first',
                text: 'diagnostic',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReasonRaw: 'unsupported persisted operation',
                rawRecord: diagnosticRawRecord,
            }),
            expect.objectContaining({
                id: localId,
                source: 'server_pending',
                text: 'edited server',
                rawRecord: expect.objectContaining({ content: { type: 'text', text: 'edited server' } }),
            }),
        ]);
    });

    it('retires action PATCH enqueue custody without inventing server snapshot provenance', async () => {
        const sessionId = 's_test_action_patch_hands_off_custody';
        const localId = 'action-patch-hands-off-custody';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'queued' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'queued', rawRecord, operation: 'enqueue',
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'local_outbound', deliveryStatus: 'queued', sendState: 'unconfirmed',
            pendingOutboxScope: outboxScope, pendingOutboxOperation: 'enqueue', text: 'queued', rawRecord,
        });

        await updatePendingRequestedActionV2({
            sessionId,
            localId,
            requestedAction: { v: 1, kind: 'steer_if_active' },
            request: async () => Response.json({ didUpdate: true }),
        });

        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                sendState: undefined,
                pendingOutboxOperation: undefined,
            }),
        ]);

        let deleteRequests = 0;
        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                deleteRequests += 1;
                return new Response(null, { status: 500 });
            },
        })).rejects.toThrow('Failed to delete pending message');
        expect(deleteRequests).toBe(1);
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                deleteRequests += 1;
                return new Response(null, { status: 204 });
            },
        })).resolves.toBeUndefined();
        expect(deleteRequests).toBe(2);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('preserves the server action-conflict code when a requested-action mutation loses its race', async () => {
        const sessionId = 's_test_action_patch_conflict';
        const localId = 'action-patch-conflict';

        await expect(updatePendingRequestedActionV2({
            sessionId,
            localId,
            requestedAction: { v: 1, kind: 'steer_now' },
            request: async () => Response.json({ error: 'action-conflict' }, { status: 409 }),
        })).rejects.toMatchObject({
            code: 'action-conflict',
        });
    });

    it('returns the exact canonical accepted Composer fact only after the pending PATCH succeeds', async () => {
        const sessionId = 's_test_pending_composer_accepted_fact';
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42, prepared: true },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const stagedMediaHandle = {
            v: 1,
            id: 'stage-42',
            executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
            owner: attachment.attachment,
            mediaKind: 'image' as const,
            mimeType: 'image/png' as const,
            name: 'issue.png',
            sizeBytes: 42,
            sha256: 'a'.repeat(64),
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1',
            localId: 'p1',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'old text',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'old text' },
                meta: {
                    happierStructuredInputV1: {
                        v: 1,
                        vendorPluginMentions: [{
                            vendorPluginRef: 'plugin://gmail@openai-curated',
                            label: 'Gmail',
                        }],
                    },
                },
            },
        });

        const result = await updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'edited text',
            structuredInput: { v: 1, composerAttachments: [attachment] },
            preparedComposerAdmission: { stagedMediaHandles: [stagedMediaHandle] },
            encryption: null,
            request: async () => new Response(null, { status: 204 }),
        } as Parameters<typeof updatePendingMessageV2Impl>[0]);

        expect(result).toEqual({
            sessionId,
            localId: 'p1',
            structuredInput: {
                v: 1,
                vendorPluginMentions: [{
                    vendorPluginRef: 'plugin://gmail@openai-curated',
                    label: 'Gmail',
                }],
                composerAttachments: [attachment],
            },
            stagedMediaHandles: [stagedMediaHandle],
        });
    });

    it('does not leave an action-ack projection delivering when zero-count pruning precedes exact transcript commit', async () => {
        const sessionId = 's_test_action_patch_zero_count_before_ack';
        const localId = 'action-patch-zero-count-before-ack';
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'queued' },
            meta: {},
        };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 1,
            text: 'queued',
            rawRecord,
            operation: 'enqueue',
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                }),
            },
        }, outboxScope);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'unconfirmed',
            pendingOutboxScope: outboxScope,
            pendingOutboxOperation: 'enqueue',
            text: 'queued',
            rawRecord,
        });
        let patchStarted!: () => void;
        const patchStartedGate = new Promise<void>((resolve) => { patchStarted = resolve; });
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });

        const update = updatePendingRequestedActionV2({
            sessionId,
            localId,
            requestedAction: { v: 1, kind: 'send_now' },
            request: async () => {
                patchStarted();
                await patchGate;
                return Response.json({ didUpdate: true });
            },
        });
        await patchStartedGate;

        storage.getState().pruneServerPendingMessages(sessionId);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                pendingOutboxOperation: 'enqueue',
            }),
        ]);

        releasePatch();
        await update;
        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                sendState: undefined,
                pendingOutboxOperation: undefined,
            }),
        ]);

        storage.getState().applyMessages(sessionId, [{
            id: 'committed-action-patch-message',
            seq: 1,
            localId,
            createdAt: 2,
            isSidechain: false,
            role: 'user',
            content: {
                type: 'text' as const,
                text: 'queued',
            },
        }]);

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it.each([true, false])(
        'keeps acknowledged requested-action projection provenance without retained enqueue custody (didUpdate=%s)',
        async (didUpdate) => {
            const sessionId = `s_test_action_patch_server_proof_${didUpdate}`;
            const localId = `action-patch-server-proof-${didUpdate}`;
            const rawRecord = {
                role: 'user' as const,
                content: { type: 'text' as const, text: 'already acknowledged enqueue' },
                meta: {},
            };
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId,
                localId,
                createdAt: 1,
                updatedAt: 1,
                source: 'local_outbound',
                deliveryStatus: 'accepted',
                pendingOutboxScope: outboxScope,
                text: 'already acknowledged enqueue',
                rawRecord,
            });

            await updatePendingRequestedActionV2({
                sessionId,
                localId,
                requestedAction: { v: 1, kind: 'steer_if_active' },
                request: async () => Response.json({ didUpdate }),
            });

            expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    source: 'local_outbound',
                    deliveryStatus: 'accepted',
                    pendingRequestedAction: { v: 1, kind: 'steer_if_active' },
                }),
            ]);
        },
    );

    it.each(['patch', 'action', 'delete', 'handled'] as const)(
        'targets the canonical server projection for %s when exact-scope quarantined custody coexists',
        async (operation) => {
            const sessionId = `s_test_quarantine_server_target_${operation}`;
            const localId = `quarantine-server-target-${operation}`;
            const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
            storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
            savePendingOutboxMessage({
                sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
                operation: 'future-operation' as never,
                request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
            }, outboxScope);
            expect(replayPersistedPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
            const diagnosticId = storage.getState().sessionPending[sessionId]?.messages[0]!.id;
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId, localId, createdAt: 2, updatedAt: 2,
                source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
                pendingDeliveryStatus: operation === 'handled' ? 'external_handoff' : 'server_queued',
                text: 'canonical server', rawRecord,
            });
            const requests: Array<Readonly<{ path: string; method: string }>> = [];
            const request = async (path: string, init?: RequestInit) => {
                const method = init?.method ?? 'GET';
                requests.push({ path, method });
                if (operation === 'action') return Response.json({ didUpdate: true });
                if (operation === 'handled' && method === 'GET') return Response.json({ pending: [] });
                return new Response(null, { status: 204 });
            };

            if (operation === 'patch') {
                await updatePendingMessageV2({
                    sessionId, pendingId: localId, text: 'edited canonical server',
                    encryption: await createPendingQueueEncryption({ sessionId }), request,
                });
            } else if (operation === 'action') {
                await updatePendingRequestedActionV2({
                    sessionId, localId, requestedAction: { v: 1, kind: 'send_now' }, request,
                });
            } else if (operation === 'delete') {
                await deletePendingMessageV2({ sessionId, pendingId: localId, request });
            } else {
                await markPendingDeliveryHandledV2({
                    sessionId, pendingId: localId,
                    encryption: await createPendingQueueEncryption({ sessionId }), request,
                });
            }

            expect(requests.length).toBeGreaterThan(0);
            expect(storage.getState().sessionPending[sessionId]?.messages).toContainEqual(expect.objectContaining({
                id: diagnosticId,
                localId,
                source: 'local_outbound',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReasonRaw: 'unsupported_persisted_operation',
            }));
            const canonical = storage.getState().sessionPending[sessionId]?.messages.find((message) => message.id === localId);
            if (operation === 'patch') {
                expect(canonical).toMatchObject({ source: 'server_pending', text: 'edited canonical server' });
            } else if (operation === 'action') {
                expect(canonical).toMatchObject({
                    source: 'server_pending',
                    pendingRequestedAction: { v: 1, kind: 'send_now' },
                });
            } else {
                expect(canonical).toBeUndefined();
            }
        },
    );

    it('keeps a synthetic quarantine diagnostic target fenced when its canonical server row coexists', async () => {
        const sessionId = 's_test_quarantine_diagnostic_target_fenced';
        const localId = 'quarantine-diagnostic-target-fenced';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
            operation: 'future-operation' as never,
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope);
        replayPersistedPendingOutboxForSession(sessionId, outboxScope);
        const diagnosticId = storage.getState().sessionPending[sessionId]?.messages[0]!.id;
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 2, updatedAt: 2,
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
            text: 'canonical server', rawRecord,
        });
        let requestCount = 0;

        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: diagnosticId,
            request: async () => {
                requestCount += 1;
                return new Response(null, { status: 204 });
            },
        })).rejects.toThrow('Persisted pending outbox row is quarantined');
        expect(requestCount).toBe(0);
    });

    it('prefers exact-scope localId identity over an unrelated exact projection ID for PATCH', async () => {
        const sessionId = 's_test_mutation_local_id_preference';
        const pendingId = 'mutation-local-id-preference';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: 'unrelated-local-id', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
            text: 'unrelated exact id', rawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'canonical-synthetic-id', localId: pendingId, createdAt: 2, updatedAt: 2,
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
            text: 'canonical local id', rawRecord,
        });

        await updatePendingMessageV2({
            sessionId, pendingId, text: 'edited canonical',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request: async () => new Response(null, { status: 204 }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: pendingId, localId: 'unrelated-local-id', text: 'unrelated exact id' }),
            expect.objectContaining({ id: 'canonical-synthetic-id', localId: pendingId, text: 'edited canonical' }),
        ]);
    });

    it('treats action localId as canonical when an unrelated projection id collides', async () => {
        const sessionId = 's_test_action_canonical_local_id_collision';
        const localId = 'action-canonical-local-id';
        const colliderLocalId = 'action-collider-local-id';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'unrelated collider' }, meta: {} };
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId: colliderLocalId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            text: 'unrelated collider',
            rawRecord,
        });
        const requests: Array<Readonly<{ path: string; method: string }>> = [];

        await updatePendingRequestedActionV2({
            sessionId,
            localId,
            requestedAction: { v: 1, kind: 'send_now' },
            request: async (path, init) => {
                requests.push({ path, method: init?.method ?? 'GET' });
                return Response.json({ didUpdate: true });
            },
        });

        expect(requests).toEqual([{
            path: `/v2/sessions/${sessionId}/pending/${localId}/action`,
            method: 'PATCH',
        }]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: localId,
                localId: colliderLocalId,
                text: 'unrelated collider',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).not.toHaveProperty('pendingRequestedAction');
    });

    it('updates the originally resolved synthetic projection when a canonical localId collider appears during PATCH', async () => {
        const sessionId = 's_test_patch_synthetic_projection_race';
        const localId = 'patch-synthetic-local-id';
        const syntheticProjectionId = 'patch-synthetic-projection-id';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'original' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: syntheticProjectionId,
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'local_outbound',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            text: 'original',
            rawRecord,
        });
        let patchStarted!: () => void;
        const patchStartedGate = new Promise<void>((resolve) => { patchStarted = resolve; });
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
        const request = async () => {
            patchStarted();
            await patchGate;
            return new Response(null, { status: 204 });
        };

        const update = updatePendingMessageV2({
            sessionId,
            pendingId: syntheticProjectionId,
            text: 'edited original',
            encryption: await createPendingQueueEncryption({ sessionId }),
            request,
        });
        await patchStartedGate;
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            text: 'collider',
            rawRecord: { ...rawRecord, content: { type: 'text', text: 'collider' } },
        });
        releasePatch();

        await expect(update).resolves.toBeUndefined();
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: syntheticProjectionId, localId, text: 'edited original' }),
            expect.objectContaining({ id: localId, localId, text: 'collider' }),
        ]);
    });

    it('does not remove a replacement collider after handled resolves a synthetic projection', async () => {
        const sessionId = 's_test_handled_synthetic_projection_race';
        const localId = 'handled-synthetic-local-id';
        const syntheticProjectionId = 'handled-synthetic-projection-id';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'original' }, meta: {} };
        storage.getState().upsertPendingMessage(sessionId, {
            id: syntheticProjectionId,
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: outboxScope,
            text: 'original',
            rawRecord,
        });
        let releaseHandled!: () => void;
        const handledGate = new Promise<void>((resolve) => { releaseHandled = resolve; });
        let handledStarted!: () => void;
        const handledStartedGate = new Promise<void>((resolve) => { handledStarted = resolve; });
        let refreshStarted!: () => void;
        const refreshStartedGate = new Promise<void>((resolve) => { refreshStarted = resolve; });
        let releaseRefresh!: () => void;
        const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
        const request = async (_path: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                handledStarted();
                await handledGate;
                return new Response(null, { status: 204 });
            }
            refreshStarted();
            await refreshGate;
            return Response.json({ pending: [] });
        };

        const handled = markPendingDeliveryHandledV2({
            sessionId,
            pendingId: syntheticProjectionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            request,
        });
        await handledStartedGate;
        storage.getState().removePendingMessage(sessionId, syntheticProjectionId);
        storage.getState().upsertPendingMessage(sessionId, {
            id: syntheticProjectionId,
            localId: 'replacement-collider-local-id',
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingOutboxScope: outboxScope,
            text: 'replacement collider',
            rawRecord: { ...rawRecord, content: { type: 'text', text: 'replacement collider' } },
        });
        releaseHandled();
        await refreshStartedGate;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: syntheticProjectionId,
                localId: 'replacement-collider-local-id',
                text: 'replacement collider',
            }),
        ]);
        releaseRefresh();
        await expect(handled).resolves.toBeUndefined();
    });

    it('allows canonical synthetic-ID server authority by localId through persisted quarantine fencing', async () => {
        const sessionId = 's_test_quarantine_synthetic_server_authority';
        const localId = 'quarantine-synthetic-server-authority';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'quarantined' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'quarantined', rawRecord,
            operation: 'future-operation' as never,
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope);
        replayPersistedPendingOutboxForSession(sessionId, outboxScope);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'canonical-server-synthetic', localId, createdAt: 2, updatedAt: 2,
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
            text: 'canonical server', rawRecord,
        });
        let requestCount = 0;

        await expect(updatePendingRequestedActionV2({
            sessionId, localId, requestedAction: { v: 1, kind: 'send_now' },
            request: async () => {
                requestCount += 1;
                return Response.json({ didUpdate: true });
            },
        })).resolves.toBeUndefined();
        expect(requestCount).toBe(1);
        expect(storage.getState().sessionPending[sessionId]?.messages).toContainEqual(expect.objectContaining({
            id: 'canonical-server-synthetic',
            localId,
            pendingRequestedAction: { v: 1, kind: 'send_now' },
        }));
    });

    it('removes the resolved canonical projection ID after confirmed DELETE', async () => {
        const sessionId = 's_test_delete_resolved_projection_id';
        const pendingId = 'delete-resolved-projection-id';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'delete' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId, localId: 'unrelated-delete-local', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
            text: 'unrelated exact id', rawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'canonical-delete-synthetic', localId: pendingId, createdAt: 2, updatedAt: 2,
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: outboxScope,
            text: 'canonical delete target', rawRecord,
        });

        await deletePendingMessageV2({
            sessionId, pendingId, request: async () => new Response(null, { status: 204 }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: pendingId, localId: 'unrelated-delete-local' }),
        ]);
    });

    it('fails closed without PATCH when exact-scope cancellation is outstanding', async () => {
        const sessionId = 's_test_patch_does_not_supersede_cancel';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'p1', localId: 'p1', createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old', rawRecord,
        });
        savePendingOutboxMessage({
            sessionId, localId: 'p1', createdAt: 1, text: 'old', rawRecord, operation: 'cancel',
            request: { v: 1, body: JSON.stringify({ localId: 'p1', content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope);
        let requestCount = 0;

        await expect(updatePendingMessageV2({
            sessionId,
            pendingId: 'p1',
            text: 'edited',
            structuredInput: { v: 1 },
            preparedComposerAdmission: { stagedMediaHandles: [] },
            encryption,
            request: async () => {
                requestCount += 1;
                return new Response(null, { status: 204 });
            },
        })).rejects.toThrow('Pending cancellation is outstanding');

        expect(requestCount).toBe(0);
        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
            expect.objectContaining({ localId: 'p1', operation: 'cancel' }),
        ]);
    });

    it('does not retire cancellation that starts while PATCH is awaiting its response', async () => {
        const sessionId = 's_test_patch_cancel_race';
        const localId = 'patch-cancel';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old', rawRecord,
        });
        savePendingOutboxMessage({
            sessionId, localId, createdAt: 1, text: 'old', rawRecord, operation: 'enqueue',
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, outboxScope);
        let patchStarted!: () => void;
        const patchStartedGate = new Promise<void>((resolve) => { patchStarted = resolve; });
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
        const request = async (_path: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') {
                patchStarted();
                await patchGate;
                return new Response(null, { status: 204 });
            }
            return new Response(null, { status: 404 });
        };

        const update = updatePendingMessageV2({
            sessionId,
            pendingId: localId,
            text: 'edited',
            structuredInput: { v: 1 },
            preparedComposerAdmission: { stagedMediaHandles: [] },
            encryption,
            request,
        });
        await patchStartedGate;
        const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });
        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
        releasePatch();

        await expect(update).resolves.toEqual({
            sessionId,
            localId,
            structuredInput: { v: 1 },
            stagedMediaHandles: [],
        });
        await expect(cancellation).resolves.toBeUndefined();
        expect(loadPendingOutboxForSession(sessionId, outboxScope)).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('does not resurrect a server row deleted successfully while PATCH awaits without outbox custody', async () => {
        const sessionId = 's_test_patch_direct_delete_race';
        const localId = 'patch-direct-delete';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', deliveryStatus: 'accepted', text: 'old', rawRecord,
        });
        let patchStarted!: () => void;
        const patchStartedGate = new Promise<void>((resolve) => { patchStarted = resolve; });
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
        const request = async (_path: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') {
                patchStarted();
                await patchGate;
            }
            return new Response(null, { status: 204 });
        };

        const update = updatePendingMessageV2({ sessionId, pendingId: localId, text: 'edited', encryption, request });
        await patchStartedGate;
        await expect(deletePendingMessageV2({ sessionId, pendingId: localId, request })).resolves.toBeUndefined();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        releasePatch();

        await expect(update).resolves.toBeUndefined();
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('applies a successful held PATCH to the current projection without restoring stale captured metadata', async () => {
        const sessionId = 's_test_patch_current_projection';
        const localId = 'patch-current-projection';
        const encryption = await createPendingQueueEncryption({ sessionId });
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'old' }, meta: {} };
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 1,
            source: 'server_pending', pendingDeliveryStatus: 'server_queued', text: 'old', rawRecord,
        });
        let patchStarted!: () => void;
        const patchStartedGate = new Promise<void>((resolve) => { patchStarted = resolve; });
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
        const update = updatePendingMessageV2({
            sessionId, pendingId: localId, text: 'edited', encryption,
            request: async () => {
                patchStarted();
                await patchGate;
                return new Response(null, { status: 204 });
            },
        });
        await patchStartedGate;
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId, createdAt: 1, updatedAt: 2,
            source: 'server_pending', pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'payload_too_large', text: 'newer projection', rawRecord,
        });
        releasePatch();

        await update;
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                text: 'edited',
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReason: 'payload_too_large',
            }),
        ]);
    });
});
