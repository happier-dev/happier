import { decodeUTF8 } from "./text";
import type { Bytes } from "../../types";

export function concatBytes(...arrays: Bytes[]): Bytes {
    let length = 0;
    for (const arr of arrays) {
        length += arr.length;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}

export function encodeUInt32(value: number): Bytes {
    return new Uint8Array([
        (value >> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff
    ]);
}

export function decodeUInt32(value: Bytes): number {
    return (value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3];
}

export function padBytes(value: Bytes, length: number): Bytes {
    if (value.length >= length) {
        throw new Error('Value is too long');
    }
    return concatBytes(value, new Uint8Array(length - value.length));
}

/**
 * Encodes a byte array with a variable-length prefix.
 * - Length 0-127: 1 byte (0xxxxxxx)
 * - Length 128-16383: 2 bytes (10xxxxxx xxxxxxxx)
 * - Length 16384-2097151: 3 bytes (110xxxxx xxxxxxxx xxxxxxxx)
 * - Length 2097152-268435455: 4 bytes (1110xxxx xxxxxxxx xxxxxxxx xxxxxxxx)
 *
 * @param data - The data to prefix with its length
 * @returns The length-prefixed data
 */
export function lengthPrefixed(data: Bytes): Bytes {
    const length = data.length;

    if (length < 0) {
        throw new Error('Length cannot be negative');
    }

    if (length <= 0x7F) {
        // 1 byte: 0xxxxxxx
        const prefix = new Uint8Array([length]);
        return concatBytes(prefix, data);
    } else if (length <= 0x3FFF) {
        // 2 bytes: 10xxxxxx xxxxxxxx
        const prefix = new Uint8Array([
            0x80 | (length >> 8),
            length & 0xFF
        ]);
        return concatBytes(prefix, data);
    } else if (length <= 0x1FFFFF) {
        // 3 bytes: 110xxxxx xxxxxxxx xxxxxxxx
        const prefix = new Uint8Array([
            0xC0 | (length >> 16),
            (length >> 8) & 0xFF,
            length & 0xFF
        ]);
        return concatBytes(prefix, data);
    } else if (length <= 0xFFFFFFF) {
        // 4 bytes: 1110xxxx xxxxxxxx xxxxxxxx xxxxxxxx
        const prefix = new Uint8Array([
            0xE0 | (length >> 24),
            (length >> 16) & 0xFF,
            (length >> 8) & 0xFF,
            length & 0xFF
        ]);
        return concatBytes(prefix, data);
    } else {
        throw new Error('Length exceeds maximum value (268435455)');
    }
}

//
// Byte Reader and Writer
//

export class ByteReader {
    #offset = 0;
    #bytes: Bytes;

    constructor(bytes: Bytes) {
        this.#bytes = bytes;
    }

    get offset(): number {
        return this.#offset;
    }

    readByte(): number {
        if (this.#offset >= this.#bytes.length) {
            throw new Error('EOF');
        }
        const value = this.#bytes[this.#offset];
        this.#offset++;
        return value;
    }

    readUInt32BE(): number {
        if (this.#offset + 4 > this.#bytes.length) {
            throw new Error('EOF');
        }
        const value = decodeUInt32(this.#bytes.slice(this.#offset, this.#offset + 4));
        this.#offset += 4;
        return value;
    }

    readUInt32LE(): number {
        if (this.#offset + 4 > this.#bytes.length) {
            throw new Error('EOF');
        }
        const value = decodeUInt32(this.#bytes.slice(this.#offset, this.#offset + 4).reverse());
        this.#offset += 4;
        return value;
    }

    readBytes(length: number): Bytes {
        if (this.#offset + length > this.#bytes.length) {
            throw new Error('EOF');
        }
        const value = this.#bytes.slice(this.#offset, this.#offset + length);
        this.#offset += length;
        return value;
    }

    readString(length: number): string {
        if (this.#offset + length > this.#bytes.length) {
            throw new Error('EOF');
        }
        return decodeUTF8(this.readBytes(length));
    }

    skip(length: number): void {
        if (this.#offset + length > this.#bytes.length) {
            throw new Error('EOF');
        }
        this.#offset += length;
    }
}
