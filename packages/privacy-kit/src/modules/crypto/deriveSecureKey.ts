import { pbkdf2_sha512 } from "./pbkdf2_sha512"
import type { Bytes } from "../../types";

/**
 * Derives a secure key using PBKDF2 with SHA-512.
 *
 * This function uses PBKDF2 (Password-Based Key Derivation Function 2) with SHA-512
 * to derive a cryptographically secure key from a base key and usage string.
 *
 * @param {Object} opts - The options object
 * @param {string} opts.key - The base key to derive from
 * @param {string} opts.usage - A string that specifies the intended usage of the derived key
 * @returns {Promise<Bytes>} A promise that resolves to a 64-byte byte array containing the derived master key
 *
 * @example
 * const masterKey = await deriveMasterKey({
 *   key: "mySecretKey",
 *   usage: "My App Encryption"
 * });
 */
export async function deriveSecureKey(opts: { key: string | Bytes | Buffer, usage: string | Bytes | Buffer }): Promise<Bytes> {
    return await pbkdf2_sha512(opts.key, opts.usage, 210000, 64); // Recommended by OWASP
}
