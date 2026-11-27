import { concatBytes } from "../formats/bytes";
import { decodeUTF8, encodeUTF8 } from "../formats/text";
import { deriveSecretKeyTreeChild } from "../crypto/deriveKey";
import * as crypto from 'crypto';
import * as tweetnacl from 'tweetnacl';
import { hmac_sha512 } from "../crypto/hmac_sha512";
import type { Bytes } from "../../types";

const PACKAGE_AES_BUFFER = 0;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;

export class KeyTree {
    static readonly symmetricEnvelopeOverheadBytes = 1 + AES_NONCE_BYTES + AES_TAG_BYTES;

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

    #startSymmetricEnvelope(path: string[]) {
        const key = this.deriveSymmetricKey(path);
        const nonce = crypto.randomBytes(AES_NONCE_BYTES);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AES_TAG_BYTES });
        return { nonce, cipher };
    }

    symmetricEncrypt(path: string[], data: Bytes | string): Bytes {
        const { nonce, cipher } = this.#startSymmetricEnvelope(path);
        return concatBytes(
            Uint8Array.of(PACKAGE_AES_BUFFER),
            nonce,
            cipher.update(typeof data === 'string' ? encodeUTF8(data) : data),
            cipher.final(),
            cipher.getAuthTag()
        );
    }

    /** Emits the same authenticated envelope as symmetricEncrypt. */
    async *symmetricEncryptChunks(path: string[], chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Bytes> {
        const { nonce, cipher } = this.#startSymmetricEnvelope(path);
        yield Uint8Array.of(PACKAGE_AES_BUFFER);
        yield nonce;
        for await (const chunk of chunks) yield cipher.update(chunk);
        const tail = cipher.final();
        if (tail.byteLength) yield tail;
        yield cipher.getAuthTag();
    }

    symmetricDecryptBuffer(path: string[], data: Bytes): Bytes {
        if (data[0] !== PACKAGE_AES_BUFFER) {
            throw new Error('Invalid data');
        }
        const key = this.deriveSymmetricKey(path);
        const bodyStart = 1 + AES_NONCE_BYTES;
        const tagStart = data.length - AES_TAG_BYTES;
        const nonce = data.subarray(1, bodyStart);
        const encrypted = data.subarray(bodyStart, tagStart);
        const authTag = data.subarray(tagStart);
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
