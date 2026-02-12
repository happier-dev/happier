import { describe, expect, it, vi } from 'vitest';

import { sealAutomationTemplateForTransport, tryReadAutomationTemplateEnvelopeExistingSessionId } from './automationTemplateTransport';

describe('automationTemplateTransport', () => {
    it('seals templates into encrypted envelope payloads', async () => {
        const encryptRaw = vi.fn(async () => 'ciphertext-base64');

        const payload = await sealAutomationTemplateForTransport({
            template: {
                directory: '/tmp/project',
                prompt: 'Run maintenance',
                existingSessionId: 'session-1',
            },
            encryptRaw,
        });

        const envelope = JSON.parse(payload);
        expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(envelope.payloadCiphertext).toBe('ciphertext-base64');
        expect(envelope.existingSessionId).toBe('session-1');
        expect(encryptRaw).toHaveBeenCalledWith(
            expect.objectContaining({
                directory: '/tmp/project',
                prompt: 'Run maintenance',
                existingSessionId: 'session-1',
            }),
        );
    });

    it('reads existingSessionId from encrypted envelope payloads without decrypting', async () => {
        const encryptRaw = vi.fn(async () => 'ciphertext-base64');

        const payload = await sealAutomationTemplateForTransport({
            template: {
                directory: '/tmp/project',
                prompt: 'Queue message',
                existingSessionId: 'session-123',
            },
            encryptRaw,
        });

        expect(tryReadAutomationTemplateEnvelopeExistingSessionId(payload)).toBe('session-123');
        expect(tryReadAutomationTemplateEnvelopeExistingSessionId('not-json')).toBeNull();
    });
});
