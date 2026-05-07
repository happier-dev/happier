import {
    decodeBase64,
    encodeBase64,
    parseSerializedJsonValue,
} from '@happier-dev/protocol';

export const DEFAULT_FUZZ_ITERATIONS = 128;
export const DEFAULT_FUZZ_SEED = 0x5eedc0de;

export type CryptoWorkerMalformedInputOperationSummary = Readonly<{
    inputItems: number;
    nullItems: number;
    validItems: number;
    validItemsAfterInvalid: number;
}>;

export type CryptoWorkerMalformedInputFuzzSummary = Readonly<{
    schema: 'happier.cryptoWorkerMalformedInputFuzz.v1';
    seed: number;
    iterations: number;
    dataKeyEnvelopeV1: CryptoWorkerMalformedInputOperationSummary;
    secretboxJson: CryptoWorkerMalformedInputOperationSummary;
    aesGcmJson: CryptoWorkerMalformedInputOperationSummary;
}>;

export type FuzzCase<TInput, TOutput> = Readonly<{
    label: string;
    input: TInput;
    expected: TOutput | null;
    validAfterInvalid?: boolean;
}>;

export type DataKeyEnvelopeInput = Readonly<{
    envelopeBase64: string;
    recipientSecretKeyOrSeedBase64: string;
}>;

export type SecretboxJsonInput = Readonly<{
    ciphertextBase64: string;
    keyBase64: string;
}>;

export type AesGcmJsonInput = Readonly<{
    encryptedPayloadBase64: string;
    keyBase64: string;
}>;

export function normalizeIterations(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_FUZZ_ITERATIONS;
    }
    return Math.max(0, Math.trunc(value));
}

export function createPrng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state;
    };
}

export function randomBytes(nextRandom: () => number, minLength: number, maxLength: number): Uint8Array {
    const length = minLength + (nextRandom() % (maxLength - minLength + 1));
    const out = new Uint8Array(length);
    for (let index = 0; index < out.length; index += 1) {
        out[index] = nextRandom() & 0xff;
    }
    return out;
}

export function bytesFromHex(hex: string): Uint8Array {
    return Uint8Array.from(hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
}

export function base64FromHex(hex: string): string {
    return encodeBase64(bytesFromHex(hex), 'base64');
}

export function base64FromBytes(bytes: Uint8Array): string {
    return encodeBase64(bytes, 'base64');
}

export function decodeBase64OrNull(value: string): Uint8Array | null {
    try {
        return decodeBase64(value, 'base64');
    } catch {
        return null;
    }
}

export function mutateFirstByte(bytes: Uint8Array, value: number): Uint8Array {
    const mutated = new Uint8Array(bytes);
    if (mutated.length > 0) {
        mutated[0] = value & 0xff;
    }
    return mutated;
}

export function fixedBytes(byte: number, length: number): Uint8Array {
    return new Uint8Array(length).fill(byte);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
}

export function parseSerializedJsonOrNull(value: string): unknown | null {
    try {
        return parseSerializedJsonValue(value);
    } catch {
        return null;
    }
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
    return Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
}

export async function summarizeCases<TInput, TOutput>(
    cases: readonly FuzzCase<TInput, TOutput>[],
    decrypt: (input: TInput) => TOutput | null | Promise<TOutput | null>,
): Promise<CryptoWorkerMalformedInputOperationSummary> {
    let nullItems = 0;
    let validItems = 0;
    let validItemsAfterInvalid = 0;

    for (const item of cases) {
        const actual = await decrypt(item.input);
        if (item.expected === null) {
            if (actual !== null) {
                throw new Error(`${item.label}: expected null but got a value`);
            }
            nullItems += 1;
            continue;
        }

        if (actual === null || !valuesEqual(actual, item.expected)) {
            throw new Error(`${item.label}: expected valid decrypt output`);
        }
        validItems += 1;
        if (item.validAfterInvalid) {
            validItemsAfterInvalid += 1;
        }
    }

    return {
        inputItems: cases.length,
        nullItems,
        validItems,
        validItemsAfterInvalid,
    };
}
