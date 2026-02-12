import { describe, expect, it } from 'vitest';

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
});

