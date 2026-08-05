import { concatBytes } from "../formats/bytes";
import { decodeUTF8, encodeUTF8 } from "../formats/text";
import { deriveSecretKeyTreeChild } from "../crypto/deriveKey";
import * as crypto from 'crypto';
import * as tweetnacl from 'tweetnacl';
import { hmac_sha512 } from "../crypto/hmac_sha512";
import type { Bytes } from "../../types";

const PACKAGE_AES_BUFFER = 0;

export class KeyTree {

    #master: Bytes

    constructor(master: Bytes) {
        this.#master = master;
        Object.freeze(this);
    }

    //
    // Subtree
    //

    subtree(path: string[]): KeyTree {
        const key = this.#deriveSubtreeKey(path);
        return new KeyTree(key);
    }

    //
    // Derive keys
    //

    deriveSymmetricKey(path: string[]): Bytes {
        return this.#deriveKey('aes256', [...path]);
    }

    deriveCurve25519Key(path: string[]): { secret: Bytes, public: Bytes } {
        const seed = this.#deriveKey('nacl', path);
        const keypair = tweetnacl.box.keyPair.fromSecretKey(seed);
        return {
            secret: Uint8Array.from(keypair.secretKey),
            public: Uint8Array.from(keypair.publicKey)
        };
    }

    //
    // Hashing
    //

    hash(path: string[], data: Bytes | string): Bytes {
        const key = this.#deriveKey('hmac_sha512', [...path]);
        return hmac_sha512(key, data);
    }

    //
    // Encryption
    //

    symmetricEncrypt(path: string[], data: Bytes | string): Bytes {
        const key = this.deriveSymmetricKey(path);
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        const encrypted = cipher.update(typeof data === 'string' ? encodeUTF8(data) : data);
        const encryptedFinal = cipher.final();
        const authTag = cipher.getAuthTag();
        return concatBytes(
            Uint8Array.from([PACKAGE_AES_BUFFER]),
            nonce,
            encrypted,
            encryptedFinal,
            authTag
        );
    }

    symmetricDecryptBuffer(path: string[], data: Bytes): Bytes {
        if (data[0] !== PACKAGE_AES_BUFFER) {
            throw new Error('Invalid data');
        }
        const key = this.deriveSymmetricKey(path);
        const nonce = data.subarray(1, 1 + 12);
        const encrypted = data.subarray(13, data.length - 16);
        const authTag = data.subarray(data.length - 16, data.length);
        const cipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        cipher.setAuthTag(authTag);

        const decrypted = cipher.update(encrypted);
        const decryptedFinal = cipher.final();
        return concatBytes(decrypted, decryptedFinal);
    }

    symmetricDecryptString(path: string[], data: Bytes): string {
        const decrypted = this.symmetricDecryptBuffer(path, data);
        return decodeUTF8(decrypted);
    }

    #deriveKey(algo: string, path: string[]): Bytes {
        for (let p of path) {
            if (p.startsWith('#')) {
                throw new Error('Path element cannot start with #');
            }
        }
        let remaining = [...path, '#' + algo];
        let state = this.#master;
        while (true) {
            let index = remaining[0];
            remaining = remaining.slice(1);
            let ch = deriveSecretKeyTreeChild(state, index);
            if (remaining.length > 0) {
                state = ch.chainCode;
            } else {
                return ch.key;
            }
        }
    }

    #deriveSubtreeKey(path: string[]): Bytes {
        for (let p of path) {
            if (p.startsWith('#')) {
                throw new Error('Path element cannot start with #');
            }
        }
        let remaining = [...path];
        let state = this.#master;
        while (true) {
            let index = remaining[0];
            remaining = remaining.slice(1);
            let ch = deriveSecretKeyTreeChild(state, index);
            if (remaining.length > 0) {
                state = ch.chainCode;
            } else {
                return ch.chainCode;
            }
        }
    }
}
