import { describe, expect, it } from 'vitest';

import { buildExistingSessionAuthoringDraftFromSessionSnapshot } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { updateExistingSessionAutomationTemplateMessage } from './automationExistingSessionTemplateUpdate';
import { sealAutomationTemplateForTransport } from './automationTemplateTransport';
import { AutomationTemplateEncryptionMaterialUnavailableError } from './automationTemplateAvailability';

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
        expect(envelope).not.toHaveProperty('existingSessionId');

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
        expect(envelope).not.toHaveProperty('existingSessionId');
    });

    it('fails closed when an encrypted template is edited without account encryption material', async () => {
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

        await expect(updateExistingSessionAutomationTemplateMessage({
            templateCiphertext: originalCiphertext,
            message: 'New message',
        })).rejects.toBeInstanceOf(AutomationTemplateEncryptionMaterialUnavailableError);
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
                        runtimeDescriptorV1: {
                            v: 1,
                            agentId: 'codex',
                            agent: { backendMode: 'acp' },
                        },
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
        expect(envelope).not.toHaveProperty('existingSessionId');
        expect(encryptedPayloads).toHaveLength(1);
        expect(encryptedPayloads[0]).toEqual(expect.objectContaining({
            prompt: 'New message',
            displayText: 'New message',
            profileId: 'profile-1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelSelection: {
                v: 1,
                updatedAt: 456,
                ref: {
                    agentTargetKey: 'backend:review-bot:configured:review-bot',
                    providerConnectionId: null,
                    modelId: 'gpt-5',
                },
            },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'acp' },
            },
            sessionEncryptionMode: 'e2ee',
            sessionEncryptionVariant: 'dataKey',
            sessionEncryptionKeyBase64: 'dek',
            existingSessionId: 's1',
        }));
        expect(encryptedPayloads[0]).not.toHaveProperty('agentTarget');
        expect(encryptedPayloads[0]).not.toHaveProperty('experimentalCodexAcp');
        expect(encryptedPayloads[0]).not.toHaveProperty('modelId');
        expect(encryptedPayloads[0]).not.toHaveProperty('modelUpdatedAt');
    });
});
