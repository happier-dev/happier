import { describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import { createEd25519SigningKeyPairFromSeed, deriveEd25519SigningSeed } from "./derivedEd25519SigningKey";

describe("Ed25519 signing-key derivation", () => {
    it("matches RFC 8032 section 7.1 test 1 including its empty-message signature", () => {
        // https://www.rfc-editor.org/rfc/rfc8032#section-7.1
        const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
        const expectedPublicKey = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
        const expectedSignature = Buffer.from(
            "e5564300c360ac729086e2cc806e828a" +
            "84877f1eb8e5d974d873e06522490155" +
            "5fb8821590a33bacc61e39701cf9b46b" +
            "d25bf5f0595bbe24655141438e7a100b",
            "hex",
        );
        const keyPair = createEd25519SigningKeyPairFromSeed(seed);
        expect(Buffer.from(keyPair.publicKey)).toEqual(expectedPublicKey);
        expect(Buffer.from(keyPair.secretKey)).toEqual(Buffer.concat([seed, expectedPublicKey]));
        const signature = tweetnacl.sign.detached(new Uint8Array(), keyPair.secretKey);
        expect(Buffer.from(signature)).toEqual(expectedSignature);
        expect(tweetnacl.sign.detached.verify(new Uint8Array(), signature, keyPair.publicKey)).toBe(true);
    });

    it("preserves NaCl key and signature bytes for raw seeds and both current server derivation domains", () => {
        const seeds: Uint8Array[] = [
            new Uint8Array(32),
            new Uint8Array(32).fill(255),
            Uint8Array.from({ length: 32 }, (_, index) => index),
        ];
        for (const domain of ["happier.account-directory.home-login.v1", "happier.machine-route-grant.v1"]) {
            for (const masterSecret of ["persisted-secret", "Unicode-secret-🔐", "rotated-secret"]) {
                seeds.push(deriveEd25519SigningSeed(masterSecret, domain));
            }
        }
        const message = new TextEncoder().encode("server signing trust-root parity");
        for (const seed of seeds) {
            const expected = tweetnacl.sign.keyPair.fromSeed(seed);
            const actual = createEd25519SigningKeyPairFromSeed(seed);
            expect(actual).toEqual(expected);
            const signature = tweetnacl.sign.detached(message, actual.secretKey);
            expect(signature).toEqual(tweetnacl.sign.detached(message, expected.secretKey));
            expect(tweetnacl.sign.detached.verify(message, signature, expected.publicKey)).toBe(true);
        }
    });

    it("reads only the seed view and returns independent key bytes", () => {
        const source = new Uint8Array(40).fill(9);
        const seed = source.subarray(4, 36);
        const expected = tweetnacl.sign.keyPair.fromSeed(seed);
        const actual = createEd25519SigningKeyPairFromSeed(seed);
        source.fill(0);
        expect(actual).toEqual(expected);
        actual.publicKey.fill(0);
        expect(actual.secretKey).toEqual(expected.secretKey);
    });

    it("rejects input that is not an Ed25519 seed", () => {
        for (const size of [0, 31, 33, 64]) {
            expect(() => createEd25519SigningKeyPairFromSeed(new Uint8Array(size))).toThrow();
        }
    });
});
