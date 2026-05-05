import tweetnacl from 'tweetnacl';
import {
    deriveBoxPublicKeyFromSeed,
    deriveBoxSecretKeyFromSeed,
} from '@happier-dev/protocol';

import { getRandomBytes } from '@/platform/cryptoRandom';

export type LibsodiumKeyPair = Readonly<{
    publicKey: Uint8Array;
    privateKey: Uint8Array;
}>;

function assertLength(name: string, value: Uint8Array, expected: number): void {
    if (value.length !== expected) {
        throw new Error(`Invalid ${name} length: ${value.length}`);
    }
}

function cryptoBoxSeedKeyPair(seed: Uint8Array): LibsodiumKeyPair {
    assertLength('crypto_box seed', seed, tweetnacl.box.secretKeyLength);
    const privateKey = deriveBoxSecretKeyFromSeed(seed);
    return {
        publicKey: deriveBoxPublicKeyFromSeed(seed),
        privateKey,
    };
}

function cryptoBoxKeyPair(): LibsodiumKeyPair {
    return cryptoBoxSeedKeyPair(getRandomBytes(tweetnacl.box.secretKeyLength));
}

function cryptoSignSeedKeyPair(seed: Uint8Array): LibsodiumKeyPair {
    assertLength('crypto_sign seed', seed, tweetnacl.sign.seedLength);
    const keyPair = tweetnacl.sign.keyPair.fromSeed(seed);
    return {
        publicKey: new Uint8Array(keyPair.publicKey),
        privateKey: new Uint8Array(keyPair.secretKey),
    };
}

function cryptoSignDetached(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
    assertLength('crypto_sign private key', privateKey, tweetnacl.sign.secretKeyLength);
    return new Uint8Array(tweetnacl.sign.detached(message, privateKey));
}

function cryptoSignVerifyDetached(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    if (signature.length !== tweetnacl.sign.signatureLength || publicKey.length !== tweetnacl.sign.publicKeyLength) {
        return false;
    }
    return tweetnacl.sign.detached.verify(message, signature, publicKey);
}

function cryptoSecretboxEasy(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
    assertLength('crypto_secretbox nonce', nonce, tweetnacl.secretbox.nonceLength);
    assertLength('crypto_secretbox key', key, tweetnacl.secretbox.keyLength);
    return new Uint8Array(tweetnacl.secretbox(message, nonce, key));
}

function cryptoSecretboxOpenEasy(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null {
    assertLength('crypto_secretbox nonce', nonce, tweetnacl.secretbox.nonceLength);
    assertLength('crypto_secretbox key', key, tweetnacl.secretbox.keyLength);
    const opened = tweetnacl.secretbox.open(ciphertext, nonce, key);
    return opened ? new Uint8Array(opened) : null;
}

const sodium = {
    ready: Promise.resolve(),
    crypto_box_PUBLICKEYBYTES: tweetnacl.box.publicKeyLength,
    crypto_box_SECRETKEYBYTES: tweetnacl.box.secretKeyLength,
    crypto_box_NONCEBYTES: tweetnacl.box.nonceLength,
    crypto_box_SEEDBYTES: tweetnacl.box.secretKeyLength,
    crypto_box_MACBYTES: tweetnacl.box.overheadLength,
    crypto_secretbox_KEYBYTES: tweetnacl.secretbox.keyLength,
    crypto_secretbox_NONCEBYTES: tweetnacl.secretbox.nonceLength,
    crypto_secretbox_MACBYTES: tweetnacl.secretbox.overheadLength,
    crypto_sign_SEEDBYTES: tweetnacl.sign.seedLength,
    crypto_sign_PUBLICKEYBYTES: tweetnacl.sign.publicKeyLength,
    crypto_sign_SECRETKEYBYTES: tweetnacl.sign.secretKeyLength,
    crypto_sign_BYTES: tweetnacl.sign.signatureLength,
    crypto_box_seed_keypair: cryptoBoxSeedKeyPair,
    crypto_box_keypair: cryptoBoxKeyPair,
    crypto_sign_seed_keypair: cryptoSignSeedKeyPair,
    crypto_sign_detached: cryptoSignDetached,
    crypto_sign_verify_detached: cryptoSignVerifyDetached,
    crypto_secretbox_easy: cryptoSecretboxEasy,
    crypto_secretbox_open_easy: cryptoSecretboxOpenEasy,
} as const;

export default sodium;
