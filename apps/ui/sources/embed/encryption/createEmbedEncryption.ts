import { openBoxBundleWithSecretKey } from '@happier-dev/protocol/crypto/boxBundle';
import { EmbedSessionOptionsV1Schema, type ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { Encryption } from '@/sync/encryption/encryption';

export type EmbedEncryption = Readonly<{
    embedPublicKey: string;
    encryption: Encryption;
    openSessionOptions: (sessionId: string, sealedOptions: string) =>
        | Readonly<{ ok: true; composerOptionsInput: ComposerOptionsInputV1 }>
        | Readonly<{ ok: false; reason: 'disposed' | 'unopenable_options' | 'invalid_options' }>;
    dispose: () => void;
}>;

/** Frame-owned, memory-only recipient material. Session AES hydration remains owned by Encryption. */
export async function createEmbedEncryption(): Promise<EmbedEncryption> {
    const seed = getRandomBytes(sodium.crypto_box_SEEDBYTES);
    const keyPair = (() => {
        try { return sodium.crypto_box_seed_keypair(seed); }
        finally { seed.fill(0); }
    })();
    let disposed = false;
    const encryption = await Encryption.createFromContentKeyPair({
        publicKey: keyPair.publicKey, machineKey: keyPair.privateKey,
    }).catch((error: unknown) => {
        keyPair.privateKey.fill(0);
        keyPair.publicKey.fill(0);
        throw error;
    });
    return {
        embedPublicKey: encodeBase64(keyPair.publicKey, 'base64url'),
        encryption,
        openSessionOptions(sessionId, sealedOptions) {
            if (disposed) return { ok: false, reason: 'disposed' };
            let opened: Uint8Array | null = null;
            try {
                opened = openBoxBundleWithSecretKey({
                    bundle: decodeBase64(sealedOptions, 'base64url'), recipientSecretKey: keyPair.privateKey,
                });
                if (!opened) return { ok: false, reason: 'unopenable_options' };
                const parsed = EmbedSessionOptionsV1Schema.safeParse(JSON.parse(new TextDecoder().decode(opened)));
                if (!parsed.success || parsed.data.sessionId !== sessionId) return { ok: false, reason: 'invalid_options' };
                return { ok: true, composerOptionsInput: parsed.data.owner };
            } catch {
                return { ok: false, reason: opened ? 'invalid_options' : 'unopenable_options' };
            } finally {
                opened?.fill(0);
            }
        },
        dispose() {
            disposed = true;
            keyPair.privateKey.fill(0);
            keyPair.publicKey.fill(0);
        },
    };
}
