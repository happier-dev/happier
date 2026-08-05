import * as crypto from 'crypto';
import type { Bytes } from '../../types';

/**
 * Computes an HMAC using SHA-512.
 *
 * This function creates a Hash-based Message Authentication Code (HMAC)
 * using the SHA-512 hash function. HMACs provide both data integrity
 * and authenticity verification.
 *
 * @param {string | Buffer | Bytes} key - The secret key used for the HMAC
 * @param {string | Buffer | Bytes} data - The data to authenticate
 * @returns {Bytes} A 64-byte byte array containing the HMAC
 *
 * @example
 * const hmac = await hmac_sha512('secretKey', 'message to authenticate');
 * console.log(hmac.toString('hex'));
 */
export function hmac_sha512(key: string | Buffer | Bytes, data: string | Buffer | Bytes): Bytes {
    let keyBuffer: Buffer = typeof key === 'string' ? Buffer.from(key, 'utf-8') : Buffer.from(key);
    let dataBuffer: Buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
    return Uint8Array.from(crypto.createHmac('sha512', keyBuffer)
        .update(dataBuffer)
        .digest());
}
