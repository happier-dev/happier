import { describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';

import {
    createAccountArtifactStoredEnvelope,
    openAccountArtifactStoredEnvelope,
    openArtifactPrivateRevisionMetadata,
    sealArtifactPrivateRevisionMetadata,
} from './accountArtifactEnvelope';

const header = Object.freeze({
    v: 1,
    kind: 'plugin.ui.archive',
    title: null,
    artifactGraph: Object.freeze({ contributionId: 'hosted' }),
});
const body = Object.freeze({ body: '{"v":1,"files":[]}' });

describe('Account Artifact stored envelope', () => {
    it('normalizes stored body fields while missing body stays unavailable', async () => {
        const envelope = { header: encodePlainArtifactStoredContent(header),
            body: encodePlainArtifactStoredContent({ ...body, extra: true }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
        await expect(openAccountArtifactStoredEnvelope({ mode: 'plain', envelope })).resolves.toEqual({ header, body });
        await expect(openAccountArtifactStoredEnvelope({ mode: 'plain', envelope: { ...envelope,
            body: encodePlainArtifactStoredContent({ extra: true }) } })).resolves.toBeNull();
    });
    it('refuses excess actor metadata before writing plaintext publicly shared content', async () => {
        const leaked = { body: 'Shared', provenance: { savedBy: { kind: 'person', accountId: 'private-actor' } } };
        await expect(createAccountArtifactStoredEnvelope({ mode: 'plain', header,
            body: leaked as unknown as Parameters<typeof createAccountArtifactStoredEnvelope>[0]['body'] })).resolves.toBeNull();
    });
    it.each(['plain', 'e2ee'] as const)('opens private %s history metadata only for its Artifact and revision', async mode => {
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const provenance = { savedBy: { kind: 'person' as const, accountId: 'owner' }, restoredFromBodyVersion: 1 };
        const dataKey = mode === 'e2ee' ? new Uint8Array(32).fill(17) : null;
        const stored = await sealArtifactPrivateRevisionMetadata({ mode, artifactId, bodyVersion: 3, provenance, dataKey });
        await expect(openArtifactPrivateRevisionMetadata({ mode, artifactId, bodyVersion: 3, provenance: stored, dataKey })).resolves.toEqual(provenance);
        await expect(openArtifactPrivateRevisionMetadata({ mode, artifactId, bodyVersion: 2, provenance: stored, dataKey })).rejects.toThrow();
        await expect(openArtifactPrivateRevisionMetadata({ mode, artifactId: '22222222-2222-4222-8222-222222222222', bodyVersion: 3,
            provenance: stored, dataKey })).rejects.toThrow();
    });
    it('opens binary body metadata in plain and E2EE envelopes without treating it as empty text', async () => {
        const binaryBody = { body: { blobId: '00000000-0000-4000-8000-000000000001', mime: 'image/png', sizeBytes: 4, sha256: 'a'.repeat(64) } };
        for (const mode of ['plain', 'e2ee'] as const) {
            let key: Uint8Array | null = null;
            const envelope = await createAccountArtifactStoredEnvelope({ mode, header,
                body: binaryBody as unknown as Parameters<typeof createAccountArtifactStoredEnvelope>[0]['body'],
                encryptDataEncryptionKey: async dataKey => { key = dataKey; return dataKey; } });
            if (!envelope) throw new Error('Expected stored envelope');
            await expect(openAccountArtifactStoredEnvelope({ mode, envelope, decryptDataEncryptionKey: async () => key })).resolves.toEqual({ header, body: binaryBody });
        }
    });
    it('round-trips the incumbent plain Artifact representation without Account key material', async () => {
        const envelope = await createAccountArtifactStoredEnvelope({
            mode: 'plain',
            header,
            body,
        });
        expect(envelope).not.toBeNull();
        if (!envelope) throw new Error('Expected plain envelope');

        await expect(openAccountArtifactStoredEnvelope({
            mode: 'plain',
            envelope,
        })).resolves.toEqual({ header, body });
        await expect(openAccountArtifactStoredEnvelope({
            mode: 'e2ee',
            envelope,
            decryptDataEncryptionKey: async () => new Uint8Array(32),
        })).resolves.toBeNull();
    });

    it('round-trips the incumbent E2EE Artifact representation only through its data-key opener', async () => {
        let encryptedDataKey: Uint8Array | null = null;
        const envelope = await createAccountArtifactStoredEnvelope({
            mode: 'e2ee',
            header,
            body,
            encryptDataEncryptionKey: async (dataKey) => {
                encryptedDataKey = new Uint8Array(dataKey);
                return encryptedDataKey;
            },
        });
        expect(envelope).not.toBeNull();
        if (!envelope || !encryptedDataKey) throw new Error('Expected E2EE envelope');

        await expect(openAccountArtifactStoredEnvelope({
            mode: 'e2ee',
            envelope,
            decryptDataEncryptionKey: async () => encryptedDataKey,
        })).resolves.toEqual({ header, body });
        await expect(openAccountArtifactStoredEnvelope({
            mode: 'plain',
            envelope,
        })).resolves.toBeNull();
    });
});
