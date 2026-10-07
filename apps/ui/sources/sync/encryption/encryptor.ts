import { decryptBox, decryptSecretBox, encryptBox, encryptSecretBox } from "@/encryption/libsodium";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium from '@/encryption/libsodium.lib';
import { decodeUTF8, encodeUTF8 } from "@/encryption/text";
import { decryptAESGCMString, encryptAESGCMString } from "@/encryption/aes";
import { openAes256GcmBytes, sealAes256GcmBytes } from '@/encryption/aes256GcmBytes';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { frameSessionDataKeyBundleV0, parseSessionDataKeyValue, readSessionDataKeyBundleV0, serializeSessionDataKeyValue, SESSION_DATA_KEY_NONCE_BYTES } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { parseSerializedJsonValue, stringifySerializedJsonValue } from '@happier-dev/protocol/crypto/serializedJsonValue';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import { yieldToEventLoop } from './cryptoBatchYield';
import {
    decryptAesGcmJsonBase64BatchWithNativeWorker,
    decryptAesGcmJsonBatchWithNativeWorker,
    decryptSecretboxJsonBase64BatchWithNativeWorker,
    decryptSecretboxJsonBatchWithNativeWorker,
    type NativeJsonDecryptWorkerBinding,
} from './nativeCryptoWorker/nativeJsonDecryptBatch';

//
// IMPORTANT: Right now there is a bug in the AES implementation and it works only with a normal strings converted to Uint8Array. 
// Any abnormal string might break encoding and decoding utf8.
//

export interface Encryptor {
    encrypt(data: any[]): Promise<Uint8Array[]>;
}

export interface Decryptor {
    decrypt(data: Uint8Array[], options?: DecryptOptions): Promise<(any | null)[]>;
}

type Base64DecryptFunction = ((data: readonly string[], options?: DecryptOptions) => Promise<(any | null)[]>) & {
    shouldDecryptBase64?: (data: readonly string[]) => boolean;
};

export interface Base64Decryptor {
    decryptBase64: Base64DecryptFunction;
}

type MaybeBase64Decryptor = Decryptor & Partial<Base64Decryptor>;

export function hasBase64Decryptor(decryptor: Decryptor): decryptor is Decryptor & Base64Decryptor {
    const candidate = decryptor as MaybeBase64Decryptor;
    return typeof candidate.decryptBase64 === 'function';
}

export type DecryptOptions = Readonly<{
    signal?: AbortSignal;
    onAuthenticationFailure?: (index: number) => void;
}>;

// The native JSON ABI uses null for both authenticated JSON null and failed
// opening. Recheck only those ambiguous items with the same cipher, without
// changing that ABI or guessing from a domain schema. Ordinary valid rows stay
// on the native batch path.
async function decryptWithNativeAuthenticationClassification<T>(
    data: readonly T[],
    binding: NativeJsonDecryptWorkerBinding,
    run: () => Promise<unknown[]>,
    classify: (item: T, onFailure: () => void) => Promise<unknown>,
    options: DecryptOptions,
): Promise<unknown[]> {
    const scope = binding.getScope();
    const results = await run();
    if (!options.onAuthenticationFailure || options.signal?.aborted || binding.isScopeCurrent?.(scope) === false) return results;
    const failures: number[] = [];
    for (let index = 0; index < results.length; index++) {
        if (results[index] !== null) continue;
        await classify(data[index], () => failures.push(index));
    }
    if (!options.signal?.aborted && binding.isScopeCurrent?.(scope) !== false) {
        for (const index of failures) options.onAuthenticationFailure(index);
    }
    return results;
}

export type SecretBoxEncryptionOptions = Readonly<{
    nativeCryptoWorker?: NativeJsonDecryptWorkerBinding;
}>;

type AesStringCryptoAdapter = Readonly<{
    encryptString: (data: string, key64: string) => Promise<string>;
    decryptString: (data: string, key64: string) => Promise<string | null>;
}>;

export type AES256EncryptionOptions = Partial<AesStringCryptoAdapter> & Readonly<{
    batchConcurrencyLimit?: number;
    nativeCryptoWorker?: NativeJsonDecryptWorkerBinding;
}>;

export const DEFAULT_AES_BATCH_CONCURRENCY_LIMIT = 4;
const DEFAULT_AES_BASE64_DECRYPT_WORKER_THRESHOLD_BYTES = 256 * 1024;
const STATIC_EXPO_PUBLIC_HAPPIER_CRYPTO_JSON_DECRYPT_WORKER_THRESHOLD_BYTES =
    process.env.EXPO_PUBLIC_HAPPIER_CRYPTO_JSON_DECRYPT_WORKER_THRESHOLD_BYTES;

export function normalizeAesBatchConcurrencyLimit(value: number | null | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_AES_BATCH_CONCURRENCY_LIMIT;
    }
    return Math.max(1, Math.trunc(value));
}

function readAesBase64DecryptWorkerThresholdBytes(): number {
    const raw = String(STATIC_EXPO_PUBLIC_HAPPIER_CRYPTO_JSON_DECRYPT_WORKER_THRESHOLD_BYTES ?? '').trim();
    if (!raw) return DEFAULT_AES_BASE64_DECRYPT_WORKER_THRESHOLD_BYTES;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_AES_BASE64_DECRYPT_WORKER_THRESHOLD_BYTES;
    return Math.max(0, Math.min(64 * 1024 * 1024, parsed));
}

function estimateBase64PayloadBytes(value: string): number {
    return Math.floor(String(value ?? '').replace(/\s/g, '').length * 3 / 4);
}

function shouldUseLargePayloadAesBase64Path(values: readonly string[]): boolean {
    const threshold = readAesBase64DecryptWorkerThresholdBytes();
    if (threshold <= 0) return values.length > 0;
    return values.some((value) => estimateBase64PayloadBytes(value) >= threshold);
}

async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrencyLimit: number,
    mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }

    const results = new Array<R>(items.length);
    const workerCount = Math.min(items.length, normalizeAesBatchConcurrencyLimit(concurrencyLimit));
    let nextIndex = 0;

    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) {
                return;
            }
            results[index] = await mapper(items[index]!, index);
        }
    }));

    return results;
}

export class SecretBoxEncryption implements Encryptor, Decryptor {
    private readonly secretKey: Uint8Array;
    private readonly nativeCryptoWorker?: NativeJsonDecryptWorkerBinding;
    readonly decryptBase64?: Base64DecryptFunction;

    constructor(secretKey: Uint8Array, options: SecretBoxEncryptionOptions = {}) {
        this.secretKey = secretKey;
        this.nativeCryptoWorker = options.nativeCryptoWorker;
        if (this.nativeCryptoWorker) {
            this.decryptBase64 = async (data, decryptOptions = {}) => this.decryptBase64WithNativeWorker(data, decryptOptions);
        }
    }

    private decryptReference(data: readonly Uint8Array[], options: DecryptOptions = {}): (any | null)[] {
        const results: (any | null)[] = [];
        for (const item of data) {
            const index = results.length;
            results.push(decryptSecretBox(item, this.secretKey, () => options.onAuthenticationFailure?.(index)));
        }
        return results;
    }

    async decrypt(data: Uint8Array[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.secretbox.decrypt',
            { items: data.length },
            async () => {
                const referenceRun = async () => this.decryptReference(data);
                const nativeCryptoWorker = this.nativeCryptoWorker;
                if (nativeCryptoWorker) {
                    return await decryptWithNativeAuthenticationClassification(data, nativeCryptoWorker, () => decryptSecretboxJsonBatchWithNativeWorker(
                        data,
                        this.secretKey,
                        nativeCryptoWorker,
                        referenceRun,
                        { signal: options.signal },
                    ), async (item, onFailure) => this.decryptReference([item], { onAuthenticationFailure: onFailure })[0], options);
                }
                return this.decryptReference(data, options);
            },
        );
    }

    private decryptBase64Reference(data: readonly string[], options: DecryptOptions = {}): (any | null)[] {
        const results: (any | null)[] = [];
        for (const item of data) {
            try {
                const index = results.length;
                results.push(decryptSecretBox(decodeBase64(item, 'base64'), this.secretKey, () => options.onAuthenticationFailure?.(index)));
            } catch {
                options.onAuthenticationFailure?.(results.length);
                results.push(null);
            }
        }
        return results;
    }

    private async decryptBase64WithNativeWorker(
        data: readonly string[],
        options: DecryptOptions = {},
    ): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.secretbox.decrypt',
            { items: data.length },
            async () => {
                const referenceRun = async () => this.decryptBase64Reference(data);
                const nativeCryptoWorker = this.nativeCryptoWorker;
                if (nativeCryptoWorker) {
                    return await decryptWithNativeAuthenticationClassification(data, nativeCryptoWorker, () => decryptSecretboxJsonBase64BatchWithNativeWorker(
                        data,
                        this.secretKey,
                        nativeCryptoWorker,
                        referenceRun,
                        { signal: options.signal },
                    ), async (item, onFailure) => this.decryptBase64Reference([item], { onAuthenticationFailure: onFailure })[0], options);
                }
                return this.decryptBase64Reference(data, options);
            },
        );
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        return syncPerformanceTelemetry.measure(
            'sync.encryption.crypto.secretbox.encrypt',
            { items: data.length },
            () => {
                // Process as batch, not Promise.all - more efficient
                const results: Uint8Array[] = [];
                for (const item of data) {
                    results.push(encryptSecretBox(item, this.secretKey));
                }
                return results;
            },
        );
    }
}

export class BoxEncryption implements Encryptor, Decryptor {
    private readonly privateKey: Uint8Array;
    private readonly publicKey: Uint8Array;

    constructor(seed: Uint8Array) {
        // Use the seed to generate a proper keypair
        const keypair = sodium.crypto_box_seed_keypair(seed);
        this.privateKey = keypair.privateKey;
        this.publicKey = keypair.publicKey;
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        return syncPerformanceTelemetry.measure(
            'sync.encryption.crypto.box.encrypt',
            { items: data.length },
            () => {
                // Process as batch, not Promise.all - more efficient
                const results: Uint8Array[] = [];
                for (const item of data) {
                    results.push(encryptBox(encodeUTF8(stringifySerializedJsonValue(item)), this.publicKey));
                }
                return results;
            },
        );
    }

    async decrypt(data: Uint8Array[], _options: DecryptOptions = {}): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measure(
            'sync.encryption.crypto.box.decrypt',
            { items: data.length },
            () => {
                // Process as batch, not Promise.all - more efficient
                const results: (any | null)[] = [];
                for (const item of data) {
                    let decrypted = decryptBox(item, this.privateKey);
                    if (!decrypted) {
                        results.push(null);
                        continue;
                    }
                    results.push(parseSerializedJsonValue(decodeUTF8(decrypted)));
                }
                return results;
            },
        );
    }
}

export class AES256Encryption implements Encryptor, Decryptor {
    private readonly secretKey: Uint8Array;
    private readonly secretKeyB64: string;
    private readonly batchConcurrencyLimit: number;
    private readonly encryptString: AesStringCryptoAdapter['encryptString'];
    private readonly decryptString: AesStringCryptoAdapter['decryptString'];
    private readonly nativeCryptoWorker?: NativeJsonDecryptWorkerBinding;
    readonly decryptBase64?: Base64DecryptFunction;

    constructor(secretKey: Uint8Array, options: AES256EncryptionOptions = {}) {
        this.secretKey = secretKey;
        this.secretKeyB64 = encodeBase64(secretKey);
        this.batchConcurrencyLimit = normalizeAesBatchConcurrencyLimit(options.batchConcurrencyLimit);
        this.encryptString = options.encryptString ?? encryptAESGCMString;
        this.decryptString = options.decryptString ?? decryptAESGCMString;
        this.nativeCryptoWorker = options.nativeCryptoWorker;
        if (this.nativeCryptoWorker) {
            this.decryptBase64 = async (data, decryptOptions = {}) => this.decryptBase64WithNativeWorker(data, decryptOptions);
            this.decryptBase64.shouldDecryptBase64 = () => true;
        } else {
            this.decryptBase64 = async (data, decryptOptions = {}) => this.decryptBase64WithoutNativeWorker(data, decryptOptions);
            this.decryptBase64.shouldDecryptBase64 = shouldUseLargePayloadAesBase64Path;
        }
    }

    /** Raw payloads use the same V0 frame, without the JSON/string adapter. */
    async encryptBytes(plaintext: Uint8Array): Promise<Uint8Array> {
        const nonce = getRandomBytes(SESSION_DATA_KEY_NONCE_BYTES);
        const ciphertext = await sealAes256GcmBytes({ key: this.secretKey, nonce, aad: new Uint8Array(), plaintext });
        const payload = new Uint8Array(nonce.length + ciphertext.length);
        payload.set(nonce);
        payload.set(ciphertext, nonce.length);
        return frameSessionDataKeyBundleV0(payload);
    }

    async decryptBytes(bundle: Uint8Array): Promise<Uint8Array> {
        const parts = readSessionDataKeyBundleV0(bundle);
        if (parts.status !== 'ready') throw new Error('Unsupported Artifact binary encryption frame');
        return openAes256GcmBytes({ key: this.secretKey, nonce: parts.nonce, aad: new Uint8Array(),
            ciphertext: parts.payload.subarray(SESSION_DATA_KEY_NONCE_BYTES) });
    }

    async encrypt(data: any[]): Promise<Uint8Array[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.aes.encrypt',
            { items: data.length, concurrency: this.batchConcurrencyLimit },
            async () => {
                return await mapWithConcurrency(data, this.batchConcurrencyLimit, async (item) => {
                    // Serialize to JSON string first
                    const encrypted = decodeBase64(
                        await this.encryptString(serializeSessionDataKeyValue(item), this.secretKeyB64)
                    );
                    return frameSessionDataKeyBundleV0(encrypted);
                });
            },
        );
    }

    async decrypt(data: Uint8Array[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.aes.decrypt',
            { items: data.length, concurrency: this.batchConcurrencyLimit },
            async () => {
                const referenceRun = async () => this.decryptReference(data);
                const nativeCryptoWorker = this.nativeCryptoWorker;
                if (nativeCryptoWorker) {
                    return await decryptWithNativeAuthenticationClassification(data, nativeCryptoWorker, () => decryptAesGcmJsonBatchWithNativeWorker(
                        data,
                        this.secretKey,
                        nativeCryptoWorker,
                        referenceRun,
                        { signal: options.signal },
                    ), (item, onFailure) => this.decryptReference([item], { onAuthenticationFailure: onFailure }), options);
                }
                return await this.decryptReference(data, options);
            },
        );
    }

    private async decryptReference(data: readonly Uint8Array[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        return await mapWithConcurrency(data, this.batchConcurrencyLimit, async (item, index) => {
            let decryptedString: string | null;
            try {
                const parts = readSessionDataKeyBundleV0(item);
                if (parts.status !== 'ready') {
                    options.onAuthenticationFailure?.(index);
                    return null;
                }
                decryptedString = await this.decryptString(encodeBase64(parts.payload), this.secretKeyB64);
            } catch (error) {
                options.onAuthenticationFailure?.(index);
                return null;
            }
            if (decryptedString === null) {
                options.onAuthenticationFailure?.(index);
                return null;
            }
            const result = parseSessionDataKeyValue(decryptedString);
            return result.status === 'authenticated' ? result.value : null;
        });
    }

    private async decryptBase64Reference(data: readonly string[], options: DecryptOptions = {}): Promise<(any | null)[]> {
        const hasLargePayload = shouldUseLargePayloadAesBase64Path(data);
        const decryptOne = async (item: string, index: number): Promise<any | null> => {
            try {
                const decrypted = await this.decryptReference([decodeBase64(item, 'base64')], {
                    onAuthenticationFailure: () => options.onAuthenticationFailure?.(index),
                });
                return decrypted.length > 0 ? decrypted[0] : null;
            } catch {
                options.onAuthenticationFailure?.(index);
                return null;
            }
        };
        if (!hasLargePayload) {
            return await mapWithConcurrency(data, this.batchConcurrencyLimit, decryptOne);
        }
        const results: (any | null)[] = [];
        for (const item of data) {
            results.push(await decryptOne(item, results.length));
            if (estimateBase64PayloadBytes(item) >= readAesBase64DecryptWorkerThresholdBytes()) {
                await yieldToEventLoop();
            }
        }
        return results;
    }

    private async decryptBase64WithNativeWorker(
        data: readonly string[],
        options: DecryptOptions = {},
    ): Promise<(any | null)[]> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.aes.decrypt',
            { items: data.length, concurrency: this.batchConcurrencyLimit },
            async () => {
                const referenceRun = async () => this.decryptBase64Reference(data);
                const nativeCryptoWorker = this.nativeCryptoWorker;
                if (nativeCryptoWorker) {
                    return await decryptWithNativeAuthenticationClassification(data, nativeCryptoWorker, () => decryptAesGcmJsonBase64BatchWithNativeWorker(
                        data,
                        this.secretKey,
                        nativeCryptoWorker,
                        referenceRun,
                        { signal: options.signal },
                    ), (item, onFailure) => this.decryptBase64Reference([item], { onAuthenticationFailure: onFailure }), options);
                }
                return await this.decryptBase64Reference(data, options);
            },
        );
    }

    private async decryptBase64WithoutNativeWorker(
        data: readonly string[],
        options: DecryptOptions = {},
    ): Promise<(any | null)[]> {
        return await syncPerformanceTelemetry.measureAsync(
            'sync.encryption.crypto.aes.decrypt',
            { items: data.length, concurrency: this.batchConcurrencyLimit },
            async () => this.decryptBase64Reference(data, options),
        );
    }
}
