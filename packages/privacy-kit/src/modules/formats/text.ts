import type { Bytes } from "../../types";

export function encodeUTF8(value: string): Bytes {
    return new TextEncoder().encode(value);
}

export function decodeUTF8(value: Bytes) {
    return new TextDecoder().decode(value);
}

export function normalizeNFKD(value: string) {
    return value.normalize('NFKD');
}
