import { describe, expect, it } from 'vitest';

import {
    createAccountArtifactStoredEnvelope,
    openAccountArtifactStoredEnvelope,
} from './accountArtifactEnvelope';

const header = Object.freeze({
    v: 1,
    kind: 'plugin.ui.archive',
    title: null,
    artifactGraph: Object.freeze({ contributionId: 'hosted' }),
});
const body = Object.freeze({ body: '{"v":1,"files":[]}' });

describe('Account Artifact stored envelope', () => {
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
