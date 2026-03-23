import { describe, expect, it } from 'vitest';

import { buildExistingSessionAuthoringDraftFromSessionSnapshot } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { updateExistingSessionAutomationTemplateMessage } from './automationExistingSessionTemplateUpdate';
import { sealAutomationTemplateForTransport } from './automationTemplateTransport';

describe('updateExistingSessionAutomationTemplateMessage', () => {
    it('decrypts, updates prompt/displayText, and reseals the envelope', async () => {
        const encryptedPayloads: unknown[] = [];
        const encryptRaw = async (value: unknown) => {
            encryptedPayloads.push(value);
            return 'ciphertext-new';
        };

        const originalCiphertext = await sealAutomationTemplateForTransport({
            template: {
                directory: '/tmp/project',
                prompt: 'Old',
                displayText: 'Old',
                existingSessionId: 's1',
                sessionEncryptionKeyBase64: 'dek',
                sessionEncryptionVariant: 'dataKey',
            },
            encryptRaw: async () => 'ciphertext-old',
        });

        const decryptRaw = async (_ciphertext: string) => ({
            directory: '/tmp/project',
            prompt: 'Old',
            displayText: 'Old',
            existingSessionId: 's1',
            sessionEncryptionKeyBase64: 'dek',
            sessionEncryptionVariant: 'dataKey',
        });

        const nextCiphertext = await updateExistingSessionAutomationTemplateMessage({
            templateCiphertext: originalCiphertext,
            message: 'New message',
            decryptRaw,
            encryptRaw,
        });

        const envelope = JSON.parse(nextCiphertext);
        expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(envelope.payloadCiphertext).toBe('ciphertext-new');
        expect(envelope.existingSessionId).toBe('s1');

        expect(encryptedPayloads).toHaveLength(1);
        expect(encryptedPayloads[0]).toEqual(
            expect.objectContaining({
                prompt: 'New message',
                displayText: 'New message',
                existingSessionId: 's1',
            }),
        );
    });

    it('updates plaintext envelopes without decrypting or encrypting', async () => {
        const decryptRaw = async (_ciphertext: string) => {
            throw new Error('unexpected decryptRaw');
        };
        const encryptRaw = async (_value: unknown) => {
            throw new Error('unexpected encryptRaw');
        };

        const originalCiphertext = JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: {
                directory: '/tmp/project',
                prompt: 'Old',
                displayText: 'Old',
                existingSessionId: 's1',
            },
            existingSessionId: 's1',
        });

        const nextCiphertext = await updateExistingSessionAutomationTemplateMessage({
            templateCiphertext: originalCiphertext,
            message: 'New message',
            decryptRaw,
            encryptRaw,
        });

        const envelope = JSON.parse(nextCiphertext);
        expect(envelope.kind).toBe('happier_automation_template_plain_v1');
        expect(envelope.payload).toEqual(expect.objectContaining({ prompt: 'New message', displayText: 'New message', existingSessionId: 's1' }));
        expect(envelope.existingSessionId).toBe('s1');
    });

    it('backfills missing inherited session runtime fields when a fallback draft is provided', async () => {
        const encryptedPayloads: unknown[] = [];
        const encryptRaw = async (value: unknown) => {
            encryptedPayloads.push(value);
            return 'ciphertext-new';
        };

        const originalCiphertext = await sealAutomationTemplateForTransport({
            template: {
                directory: '/tmp/project',
                prompt: 'Old',
                displayText: 'Old',
                existingSessionId: 's1',
                sessionEncryptionKeyBase64: 'dek',
                sessionEncryptionVariant: 'dataKey',
            },
            encryptRaw: async () => 'ciphertext-old',
        });

        const nextCiphertext = await updateExistingSessionAutomationTemplateMessage({
            templateCiphertext: originalCiphertext,
            message: 'New message',
            decryptRaw: async () => ({
                directory: '/tmp/project',
                prompt: 'Old',
                displayText: 'Old',
                existingSessionId: 's1',
                sessionEncryptionKeyBase64: 'dek',
                sessionEncryptionVariant: 'dataKey',
            }),
            encryptRaw,
            fallbackDraft: buildExistingSessionAuthoringDraftFromSessionSnapshot({
                session: {
                    id: 's1',
                    encryptionMode: 'e2ee',
                    metadata: {
                        path: '/tmp/project',
                        host: 'qa-host',
                        homeDir: '/tmp',
                        profileId: 'profile-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-session-1',
                        codexBackendMode: 'acp',
                        acpConfiguredBackendV1: {
                            v: 1,
                            updatedAt: 20,
                            backendId: 'review-bot',
                            title: 'Review Bot',
                        },
                    },
                    permissionMode: 'acceptEdits',
                    permissionModeUpdatedAt: 123,
                    modelMode: 'gpt-5',
                    modelModeUpdatedAt: 456,
                },
                message: 'New message',
                sessionDekBase64: 'dek',
            }),
        });

        const envelope = JSON.parse(nextCiphertext);
        expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(envelope.existingSessionId).toBe('s1');
        expect(encryptedPayloads).toHaveLength(1);
        expect(encryptedPayloads[0]).toEqual(expect.objectContaining({
            prompt: 'New message',
            displayText: 'New message',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            profileId: 'profile-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'gpt-5',
            modelUpdatedAt: 456,
            codexBackendMode: 'acp',
            existingSessionId: 's1',
        }));
        expect(encryptedPayloads[0]).not.toHaveProperty('experimentalCodexAcp');
    });
});
