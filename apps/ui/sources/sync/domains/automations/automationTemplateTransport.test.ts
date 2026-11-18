import { describe, expect, it, vi } from 'vitest';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import { AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED }
    from '../../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { decodeAutomationTemplate } from './automationTemplateCodec';

import {
    encodeAutomationTemplateForTransport,
    resolveAutomationTemplatePayload,
    sealAutomationTemplateForTransport,
    tryDecodeAutomationTemplateEnvelope,
} from './automationTemplateTransport';

describe('automationTemplateTransport', () => {
    it.each([AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED])
        ('reads exact 0.2 existing-session bytes through the shared predecessor codec', async (templateCiphertext) => {
            const result = await resolveAutomationTemplatePayload({ templateCiphertext,
                decryptRaw: async ciphertext => openAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
                    ciphertext, material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } })?.value ?? null });
            expect(result.kind).toBe('ready');
            if (result.kind !== 'ready') return;
            expect(decodeAutomationTemplate(JSON.stringify(result.payload))).toMatchObject({
                directory: '/repo', prompt: 'Review the release', existingSessionId: 'session-old' });
        });
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
        expect(envelope).not.toHaveProperty('existingSessionId');
        expect(encryptRaw).toHaveBeenCalledWith(
            expect.objectContaining({
                directory: '/tmp/project',
                prompt: 'Run maintenance',
                transcriptStorage: 'direct',
                existingSessionId: 'session-1',
            }),
        );
    });

    it('roundtrips provider-bound model identity through plaintext envelope payloads for plain accounts', async () => {
        const encryptRaw = vi.fn(async () => 'ciphertext-base64');
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'openai/gpt-5.5',
            },
        });

        const payload = await encodeAutomationTemplateForTransport({
            accountMode: 'plain',
            template: {
                directory: '/tmp/project',
                prompt: 'Run maintenance',
                transcriptStorage: 'direct',
                existingSessionId: 'session-1',
                backendTarget: { kind: 'backend', backendId: 'codex' },
                modelSelection,
            },
            encryptRaw,
        });

        const envelope = JSON.parse(payload);
        expect(envelope.kind).toBe('happier_automation_template_plain_v1');
        expect(envelope.payload).toEqual(expect.objectContaining({ directory: '/tmp/project', prompt: 'Run maintenance', transcriptStorage: 'direct', existingSessionId: 'session-1' }));
        expect(decodeAutomationTemplate(JSON.stringify(envelope.payload))?.modelSelection).toEqual(modelSelection);
        expect(envelope).not.toHaveProperty('existingSessionId');
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
        expect(envelope).not.toHaveProperty('existingSessionId');
        expect(encryptRaw).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionEncryptionKeyBase64: 'dek-base64',
            }),
        );
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

    it('resolves plain payloads and reports encrypted payloads as locked when key material is unavailable', async () => {
        const plain = await resolveAutomationTemplatePayload({
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_plain_v1',
                payload: { prompt: 'Plain' },
            }),
        });
        expect(plain).toEqual({
            kind: 'ready',
            envelope: {
                kind: 'happier_automation_template_plain_v1',
                payload: { prompt: 'Plain' },
            },
            payload: { prompt: 'Plain' },
        });

        const encryptedWithoutReader = await resolveAutomationTemplatePayload({
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'ciphertext',
            }),
        });
        expect(encryptedWithoutReader).toEqual({
            kind: 'locked',
            reason: 'encryption_material_unavailable',
        });

        const encryptedWithoutMaterial = await resolveAutomationTemplatePayload({
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'ciphertext',
            }),
            decryptRaw: async () => null,
        });
        expect(encryptedWithoutMaterial).toEqual({
            kind: 'locked',
            reason: 'encryption_material_unavailable',
        });
    });
});
