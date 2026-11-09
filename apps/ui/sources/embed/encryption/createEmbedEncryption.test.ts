import { describe, expect, it } from 'vitest';
import { sealBoxBundle} from '@happier-dev/protocol/crypto/boxBundle';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { projectComposerOptionsInputV1 } from '@happier-dev/protocol/embed';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { createSessionDataKeyHydrationPlan, hydrateSessionDataKeys } from '@/sync/encryption/sessionDataKeyHydration';
import { getModelOptionsForSession } from '@/sync/domains/models/modelOptions';
import { resolveSessionConfigOptionOverridesFromMetadata } from '@/sync/domains/sessionControl/configOptionsControl';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { createEmbedEncryption } from './createEmbedEncryption';

const randomBytes = (length: number) => new Uint8Array(length).fill(7);

describe('ephemeral embed encryption', () => {
    it('opens the real session envelope through canonical hydration and decrypts session content', async () => {
        const root = await createEmbedEncryption();
        const dataKey = new Uint8Array(32).fill(11);
        const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: decodeBase64(root.embedPublicKey, 'base64url'), randomBytes,
        }), 'base64');
        const sessionDataKeys = new Map<string, Uint8Array>();
        const plan = createSessionDataKeyHydrationPlan({
            sessions: [{ id: 's', encryptionMode: 'e2ee', dataEncryptionKey: envelope, viewerRole: 'recipient' }],
            credentialKind: 'keyless', sessionDataKeys,
        });
        const result = await hydrateSessionDataKeys({ plan, encryption: root.encryption, sessionDataKeys });
        expect(result.states.get('s')).toBe('ready');
        expect(result.sessionKeys.get('s')).toEqual(dataKey);
        await root.encryption.initializeSessions(result.sessionKeys);
        const session = root.encryption.getSessionEncryption('s')!;
        const ciphertext = await session.encryptRaw({ role: 'user', content: 'hello' });
        expect(await session.decryptRaw(ciphertext)).toEqual({ role: 'user', content: 'hello' });
        root.encryption.removeSessionEncryption('s');
        for (const key of sessionDataKeys.values()) key.fill(0);
        root.dispose();
    });

    it('classifies a wrong recipient key as unopenable without the Account fallback', async () => {
        const root = await createEmbedEncryption();
        const wrongRoot = await createEmbedEncryption();
        const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey: new Uint8Array(32).fill(11),
            recipientPublicKey: decodeBase64(wrongRoot.embedPublicKey, 'base64url'), randomBytes,
        }), 'base64');
        const result = await hydrateSessionDataKeys({
            plan: createSessionDataKeyHydrationPlan({
                sessions: [{ id: 's', encryptionMode: 'e2ee', dataEncryptionKey: envelope, viewerRole: 'recipient' }],
                credentialKind: 'keyless', sessionDataKeys: new Map(),
            }),
            encryption: root.encryption, sessionDataKeys: new Map(),
        });
        expect(result.states.get('s')).toBe('unopenable_envelope');
        expect(result.sessionKeys.has('s')).toBe(false);
        root.dispose();
        wrongRoot.dispose();
    });

    it('opens only bounded session-bound options with real model and config-reader parity', async () => {
        const root = await createEmbedEncryption();
        const metadata = MetadataSchema.parse({
            path: '/private/workspace', host: 'private-host',
            sessionModelsV1: {
                v: 1, agentId: 'codex', updatedAt: 10, currentModelId: 'model-a',
                availableModels: [{ id: 'model-a', name: 'Model A', modelOptions: [{
                    id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false,
                }] }],
            },
            modelOverrideV1: { v: 1, modelId: 'requested-model', updatedAt: 20 },
            sessionConfigOptionOverridesV1: { v: 1, updatedAt: 10, overrides: {
                thinking: { value: false, updatedAt: 10 },
            } },
            acpConfigOptionOverridesV1: { v: 1, updatedAt: 20, overrides: {
                thinking: { value: true, updatedAt: 20 },
            } },
        });
        const owner = projectComposerOptionsInputV1(metadata);
        const sealOptions = (value: unknown) => encodeBase64(sealBoxBundle({
            plaintext: new TextEncoder().encode(JSON.stringify(value)),
            recipientPublicKey: decodeBase64(root.embedPublicKey, 'base64url'), randomBytes,
        }), 'base64url');
        const sealed = sealOptions({ v: 1, sessionId: 's', owner });
        const opened = root.openSessionOptions('s', sealed);
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error('Expected opened options');
        expect(Object.keys(opened.composerOptionsInput)).not.toContain('path');
        expect(getModelOptionsForSession('codex', opened.composerOptionsInput)).toEqual(getModelOptionsForSession('codex', metadata));
        const configOptions = [{ id: 'thinking' }];
        expect(resolveSessionConfigOptionOverridesFromMetadata({ metadata: opened.composerOptionsInput, configOptions }))
            .toEqual(resolveSessionConfigOptionOverridesFromMetadata({ metadata, configOptions }));
        expect(root.openSessionOptions('other', sealed)).toEqual({ ok: false, reason: 'invalid_options' });
        expect(root.openSessionOptions('s', sealOptions({ v: 1, sessionId: 's', owner: { ...owner, path: '/leak' } })))
            .toEqual({ ok: false, reason: 'invalid_options' });
        const privateKey = root.encryption.getContentPrivateKey();
        root.dispose();
        expect(privateKey.every((byte) => byte === 0)).toBe(true);
        expect(root.openSessionOptions('s', sealed)).toEqual({ ok: false, reason: 'disposed' });
    });
});
