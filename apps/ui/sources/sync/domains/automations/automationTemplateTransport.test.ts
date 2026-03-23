import { describe, expect, it, vi } from 'vitest';

import {
    encodeAutomationTemplateForTransport,
    sealAutomationTemplateForTransport,
    tryDecodeAutomationTemplateEnvelope,
    tryReadAutomationTemplateEnvelopeExistingSessionId,
} from './automationTemplateTransport';

describe('automationTemplateTransport', () => {
    it('seals templates into encrypted envelope payloads', async () => {
        const encryptRaw = vi.fn(async () => 'ciphertext-base64');

        const payload = await encodeAutomationTemplateForTransport({
            accountMode: 'e2ee',
            template: {
                directory: '/tmp/project',
                prompt: 'Run maintenance',
                transcriptStorage: 'direct',
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
                transcriptStorage: 'direct',
                existingSessionId: 'session-1',
            }),
        );
    });

    it('encodes templates into plaintext envelope payloads for plain accounts', async () => {
        const encryptRaw = vi.fn(async () => 'ciphertext-base64');

        const payload = await encodeAutomationTemplateForTransport({
            accountMode: 'plain',
            template: {
                directory: '/tmp/project',
                prompt: 'Run maintenance',
                transcriptStorage: 'direct',
                existingSessionId: 'session-1',
            },
            encryptRaw,
        });

        const envelope = JSON.parse(payload);
        expect(envelope.kind).toBe('happier_automation_template_plain_v1');
        expect(envelope.payload).toEqual(expect.objectContaining({ directory: '/tmp/project', prompt: 'Run maintenance', transcriptStorage: 'direct', existingSessionId: 'session-1' }));
        expect(envelope.existingSessionId).toBe('session-1');
        expect(encryptRaw).not.toHaveBeenCalled();
    });

    it('seals templates that include a session encryption key even for plain accounts', async () => {
        const encryptRaw = vi.fn(async () => 'ciphertext-base64');

        const payload = await encodeAutomationTemplateForTransport({
            accountMode: 'plain',
            template: {
                directory: '/tmp/project',
                prompt: 'Queue message',
                existingSessionId: 'session-1',
                sessionEncryptionVariant: 'dataKey',
                sessionEncryptionKeyBase64: 'dek-base64',
            },
            encryptRaw,
        });

        const envelope = JSON.parse(payload);
        expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
        expect(envelope.payloadCiphertext).toBe('ciphertext-base64');
        expect(envelope.existingSessionId).toBe('session-1');
        expect(encryptRaw).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionEncryptionKeyBase64: 'dek-base64',
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
        expect(tryReadAutomationTemplateEnvelopeExistingSessionId(JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: { directory: '/tmp/project', existingSessionId: 'session-123' },
            existingSessionId: 'session-123',
        }))).toBe('session-123');
        expect(tryReadAutomationTemplateEnvelopeExistingSessionId('not-json')).toBeNull();
    });

    it('decodes both encrypted and plaintext template envelopes', async () => {
        const encrypted = await sealAutomationTemplateForTransport({
            template: { directory: '/tmp/project', prompt: 'Hi', existingSessionId: 'session-9' },
            encryptRaw: async () => 'ciphertext-base64',
        });
        expect(tryDecodeAutomationTemplateEnvelope(encrypted)?.kind).toBe('happier_automation_template_encrypted_v1');

        const plain = JSON.stringify({
            kind: 'happier_automation_template_plain_v1',
            payload: { directory: '/tmp/project', prompt: 'Hi', existingSessionId: 'session-9' },
        });
        expect(tryDecodeAutomationTemplateEnvelope(plain)?.kind).toBe('happier_automation_template_plain_v1');
    });
});
