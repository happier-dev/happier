import { createHash, createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import tweetnacl from "tweetnacl";

// RFC 8410 section 7: PKCS#8 Ed25519 AlgorithmIdentifier followed by
// an OCTET STRING containing the 32-byte seed (OID 1.3.101.112).
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Derives the established NaCl seed || public-key layout using native Ed25519. */
export function createEd25519SigningKeyPairFromSeed(seed: Uint8Array): tweetnacl.SignKeyPair {
    if (seed.length !== tweetnacl.sign.seedLength) throw new Error("bad seed size");
    const privateKey = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
    });
    // RFC 8410 section 4: Ed25519 SPKI ends with the raw 32-byte public key.
    const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    const publicKey = new Uint8Array(publicKeyDer.subarray(-tweetnacl.sign.publicKeyLength));
    const secretKey = new Uint8Array(tweetnacl.sign.secretKeyLength);
    secretKey.set(seed);
    secretKey.set(publicKey, tweetnacl.sign.seedLength);
    return { publicKey, secretKey };
}

/**
 * Derives an Ed25519 seed in the server's established master-secret key tree.
 * Each caller owns a distinct domain; changing a domain changes persisted trust roots.
 */
export function deriveEd25519SigningSeed(masterSecret: string, domain: string): Uint8Array {
    return new Uint8Array(createHmac("sha512", `${domain} Master Seed`)
        .update(masterSecret, "utf8")
        .digest()
        .subarray(0, tweetnacl.sign.seedLength));
}

/** Stable identifier convention for server-derived Ed25519 public keys. */
export function createEd25519PublicKeyId(publicKey: Uint8Array): string {
    return createHash("sha256").update(publicKey).digest("hex");
}
