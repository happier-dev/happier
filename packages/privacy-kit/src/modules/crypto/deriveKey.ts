import { concatBytes } from "../formats/bytes";
import { encodeUTF8 } from "../formats/text";
import { hmac_sha512 } from "./hmac_sha512";
import type { Bytes } from "../../types";

export type KeyTreeState = {
    key: Bytes,
    chainCode: Bytes
};

export function deriveSecretKeyTreeRoot(seed: string | Bytes | Buffer, usage: string): KeyTreeState {
    const I = hmac_sha512(usage + ' Master Seed', seed);
    return {
        key: I.slice(0, 32),
        chainCode: I.slice(32)
    };
}

export function deriveSecretKeyTreeChild(chainCode: Bytes, index: string): KeyTreeState {

    // Prepare data
    const data = concatBytes(new Uint8Array([0x0]), encodeUTF8(index)); // prepend 0x00 for separator

    // Derive key
    const I = hmac_sha512(chainCode, data);
    return {
        key: I.subarray(0, 32),
        chainCode: I.subarray(32),
    };
}

export function deriveKey(master: Bytes, usage: string, path: string[]): Bytes {
    let state = deriveSecretKeyTreeRoot(master, usage);
    let remaining = [...path];
    while (remaining.length > 0) {
        let index = remaining[0];
        remaining = remaining.slice(1);
        state = deriveSecretKeyTreeChild(state.chainCode, index);
    }
    return state.key;
}
