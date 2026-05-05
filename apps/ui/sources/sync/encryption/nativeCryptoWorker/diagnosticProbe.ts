import { encodeBase64 } from '@/encryption/base64';
import { decodeHex } from '@/encryption/hex';
import { createNativeCryptoWorker } from './nativeCryptoWorker';
import { UI_CRYPTO_GOLDEN_VECTORS } from './cryptoGoldenVectors';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    type CryptoWorkerScope,
    type NativeCryptoWorker,
    type NativeCryptoWorkerAesGcmJsonItem,
    type NativeCryptoWorkerBatchOk,
    type NativeCryptoWorkerBatchResult,
    type NativeCryptoWorkerBatchSource,
    type NativeCryptoWorkerCapability,
    type NativeCryptoWorkerDataKeyEnvelopeItem,
    type NativeCryptoWorkerOperation,
    type NativeCryptoWorkerSecretboxJsonItem,
} from './types';
import { CRYPTO_GOLDEN_VECTORS, parseSerializedJsonValue } from '@happier-dev/protocol';

export type NativeCryptoWorkerProbeCheckStatus = 'pass' | 'fail' | 'skipped';

export type NativeCryptoWorkerProbeCheck = Readonly<{
    status: NativeCryptoWorkerProbeCheckStatus;
    detail: string;
}>;

export type NativeCryptoWorkerProbeReport = Readonly<{
    status: 'pass' | 'fail';
    checks: Readonly<{
        moduleAvailable: NativeCryptoWorkerProbeCheck;
        batchSource: NativeCryptoWorkerProbeCheck;
        dataKey: NativeCryptoWorkerProbeCheck;
        secretbox: NativeCryptoWorkerProbeCheck;
        aesGcm: NativeCryptoWorkerProbeCheck;
        invalidItems: NativeCryptoWorkerProbeCheck;
        jsResponsive: NativeCryptoWorkerProbeCheck;
    }>;
    evidence: Readonly<{
        batchSources: readonly NativeCryptoWorkerBatchSource[];
        capability: Readonly<{
            available: boolean;
            failureReason: number;
            nativeVersion: number | null;
            warmupMs: number | null;
            supportedOperations: readonly NativeCryptoWorkerOperation[];
        }>;
        dataKey: Readonly<{ validItems: number; nullItems: number }>;
        secretbox: Readonly<{ validItems: number; nullItems: number }>;
        aesGcm: Readonly<{ validItems: number; nullItems: number }>;
        invalidItems: Readonly<{ nullItems: number; validItemsAfterInvalid: number }>;
        jsResponsiveness: Readonly<{ ticks: number; batchItems: number; elapsedMs: number }>;
    }>;
}>;

export type RunNativeCryptoWorkerProbeOptions = Readonly<{
    worker?: NativeCryptoWorker;
    expectedBatchSource?: Exclude<NativeCryptoWorkerBatchSource, 'cancelled'>;
    requireJsResponsiveness?: boolean;
    responsivenessBatchSize?: number;
}>;

const probeScope: CryptoWorkerScope = {
    accountId: 'native-crypto-worker-probe',
    serverId: 'native-runtime',
    generation: 1,
};

const invalidDataKeyItems = 2;
const invalidSecretboxItems = 2;
const invalidAesGcmItems = 2;

function nowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

function base64FromHex(hex: string): string {
    return encodeBase64(decodeHex(hex));
}

function withoutBase64Padding(value: string): string {
    return value.replace(/=+$/u, '');
}

function withBase64Whitespace(value: string): string {
    const splitAt = Math.min(8, Math.max(1, value.length - 1));
    return `${value.slice(0, splitAt)} \n\t${value.slice(splitAt)}`;
}

function check(status: NativeCryptoWorkerProbeCheckStatus, detail: string): NativeCryptoWorkerProbeCheck {
    return { status, detail };
}

function valuesMatch(actual: unknown, expected: unknown): boolean {
    if (Object.is(actual, expected)) return true;
    return JSON.stringify(actual) === JSON.stringify(expected);
}

function countNulls(items: readonly unknown[]): number {
    return items.filter((item) => item === null).length;
}

function countMatchingIndexes(
    actual: readonly unknown[],
    expected: readonly unknown[],
    indexes: readonly number[],
): number {
    return indexes.filter((index) => valuesMatch(actual[index], expected[index])).length;
}

function countNullIndexes(items: readonly unknown[], indexes: readonly number[]): number {
    return indexes.filter((index) => items[index] === null).length;
}

function okResult<T>(
    result: NativeCryptoWorkerBatchResult<T>,
): NativeCryptoWorkerBatchOk<T> | null {
    return result.status === 'ok' ? result : null;
}

function sanitizeErrorDetail(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function normalizeError(error: unknown): string {
    const record = typeof error === 'object' && error !== null
        ? error as Partial<Record<'code' | 'failureReason' | 'message' | 'name', unknown>>
        : {};
    const name = error instanceof Error && error.name
        ? error.name
        : typeof record.name === 'string'
            ? record.name
            : 'unknown-error';
    const parts = [sanitizeErrorDetail(name)];
    if (typeof record.code === 'string' && record.code.trim()) {
        parts.push(`code=${sanitizeErrorDetail(record.code)}`);
    }
    if (typeof record.failureReason === 'number' && Number.isFinite(record.failureReason)) {
        parts.push(`failureReason=${record.failureReason}`);
    }
    const message = error instanceof Error
        ? error.message
        : typeof record.message === 'string'
            ? record.message
            : '';
    if (message.trim()) {
        parts.push(`message=${sanitizeErrorDetail(message)}`);
    }
    return parts.join(' ');
}

function supportedOperationsMatch(supportedOperations: readonly NativeCryptoWorkerOperation[]): boolean {
    return [
        NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
        NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson,
        NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson,
    ].every((operation) => supportedOperations.includes(operation));
}

function buildDataKeyItems(): readonly NativeCryptoWorkerDataKeyEnvelopeItem[] {
    const direct = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey;
    const compatibility = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.compatibilitySeed;
    const wrongRecipientSecret = base64FromHex('11'.repeat(32));

    return [
        {
            envelopeBase64: base64FromHex(direct.envelope.hex),
            recipientSecretKeyOrSeedBase64: base64FromHex(direct.recipientSecretKeyOrSeed.hex),
        },
        {
            envelopeBase64: base64FromHex(compatibility.envelope.hex),
            recipientSecretKeyOrSeedBase64: base64FromHex(compatibility.recipientSecretKeyOrSeed.hex),
        },
        {
            envelopeBase64: base64FromHex(direct.envelope.hex),
            recipientSecretKeyOrSeedBase64: withoutBase64Padding(base64FromHex(direct.recipientSecretKeyOrSeed.hex)),
        },
        {
            envelopeBase64: withBase64Whitespace(base64FromHex(direct.envelope.hex)),
            recipientSecretKeyOrSeedBase64: withBase64Whitespace(base64FromHex(direct.recipientSecretKeyOrSeed.hex)),
        },
        {
            envelopeBase64: base64FromHex(direct.envelope.hex),
            recipientSecretKeyOrSeedBase64: wrongRecipientSecret,
        },
        {
            envelopeBase64: base64FromHex(CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.malformedEnvelope.hex),
            recipientSecretKeyOrSeedBase64: base64FromHex(direct.recipientSecretKeyOrSeed.hex),
        },
        {
            envelopeBase64: base64FromHex(direct.envelope.hex),
            recipientSecretKeyOrSeedBase64: base64FromHex(direct.recipientSecretKeyOrSeed.hex),
        },
    ];
}

function buildExpectedDataKeyItems(): readonly (string | null)[] {
    const direct = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.directSecretKey;
    const compatibility = CRYPTO_GOLDEN_VECTORS.encryptedDataKeyEnvelopeV1.compatibilitySeed;

    return [
        base64FromHex(direct.dataKey.hex),
        base64FromHex(compatibility.dataKey.hex),
        base64FromHex(direct.dataKey.hex),
        base64FromHex(direct.dataKey.hex),
        null,
        null,
        base64FromHex(direct.dataKey.hex),
    ];
}

function buildSecretboxItems(): readonly NativeCryptoWorkerSecretboxJsonItem[] {
    const keyBase64 = base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex);
    const wrongKeyBase64 = base64FromHex('f'.repeat(64));
    const [firstVector, secondVector] = UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values;

    return [
        ...UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values.map((vector) => ({
            ciphertextBase64: base64FromHex(vector.encryptedHex),
            keyBase64,
        })),
        {
            ciphertextBase64: withoutBase64Padding(base64FromHex(firstVector.encryptedHex)),
            keyBase64: withoutBase64Padding(keyBase64),
        },
        {
            ciphertextBase64: withBase64Whitespace(base64FromHex(secondVector.encryptedHex)),
            keyBase64: withBase64Whitespace(keyBase64),
        },
        {
            ciphertextBase64: base64FromHex(firstVector.encryptedHex),
            keyBase64: wrongKeyBase64,
        },
        {
            ciphertextBase64: 'not-base64',
            keyBase64,
        },
        {
            ciphertextBase64: base64FromHex(firstVector.encryptedHex),
            keyBase64,
        },
    ];
}

function buildExpectedSecretboxItems(): readonly unknown[] {
    const [firstVector, secondVector] = UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values;
    return [
        ...UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values.map((vector) => parseSerializedJsonValue(vector.serialized)),
        parseSerializedJsonValue(firstVector.serialized),
        parseSerializedJsonValue(secondVector.serialized),
        null,
        null,
        parseSerializedJsonValue(firstVector.serialized),
    ];
}

function buildAesGcmItems(): readonly NativeCryptoWorkerAesGcmJsonItem[] {
    const keyBase64 = base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.keyHex);
    const wrongKeyBase64 = base64FromHex('e'.repeat(64));
    const [firstVector, secondVector] = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values;

    return [
        ...UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values.map((vector) => ({
            encryptedPayloadBase64: base64FromHex(vector.encryptedPayloadHex),
            keyBase64,
        })),
        {
            encryptedPayloadBase64: withoutBase64Padding(base64FromHex(firstVector.encryptedPayloadHex)),
            keyBase64: withoutBase64Padding(keyBase64),
        },
        {
            encryptedPayloadBase64: withBase64Whitespace(base64FromHex(secondVector.encryptedPayloadHex)),
            keyBase64: withBase64Whitespace(keyBase64),
        },
        {
            encryptedPayloadBase64: base64FromHex(firstVector.encryptedPayloadHex),
            keyBase64: wrongKeyBase64,
        },
        {
            encryptedPayloadBase64: 'not-base64',
            keyBase64,
        },
        {
            encryptedPayloadBase64: base64FromHex(firstVector.encryptedPayloadHex),
            keyBase64,
        },
    ];
}

function buildExpectedAesGcmItems(): readonly unknown[] {
    const [firstVector, secondVector] = UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values;
    return [
        ...UI_CRYPTO_GOLDEN_VECTORS.aesGcmJson.values.map((vector) => parseSerializedJsonValue(vector.serialized)),
        parseSerializedJsonValue(firstVector.serialized),
        parseSerializedJsonValue(secondVector.serialized),
        null,
        null,
        parseSerializedJsonValue(firstVector.serialized),
    ];
}

function resultItemsMatch(actual: readonly unknown[], expected: readonly unknown[]): boolean {
    return actual.length === expected.length && actual.every((item, index) => valuesMatch(item, expected[index]));
}

function collectBatchSources(
    results: readonly (NativeCryptoWorkerBatchOk<unknown> | null)[],
): readonly NativeCryptoWorkerBatchSource[] {
    return Array.from(new Set(results.flatMap((result) => result ? [result.source] : []))).sort();
}

async function measureJsResponsiveness(
    worker: NativeCryptoWorker,
    batchSize: number,
): Promise<{ check: NativeCryptoWorkerProbeCheck; ticks: number; batchItems: number; elapsedMs: number }> {
    const [vector] = UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.values;
    const item: NativeCryptoWorkerSecretboxJsonItem = {
        ciphertextBase64: base64FromHex(vector.encryptedHex),
        keyBase64: base64FromHex(UI_CRYPTO_GOLDEN_VECTORS.secretboxJson.keyHex),
    };
    const items = Array.from({ length: batchSize }, () => item);
    let ticks = 0;
    const interval = setInterval(() => {
        ticks += 1;
    }, 0);
    const startedAt = nowMs();
    try {
        const result = await worker.decryptSecretboxJson({ scope: probeScope, items });
        const elapsedMs = Math.trunc(nowMs() - startedAt);
        const status = result.status === 'ok' && ticks > 0 ? 'pass' : 'fail';
        return {
            check: check(status, `${ticks} timer ticks during ${items.length} native worker items`),
            ticks,
            batchItems: items.length,
            elapsedMs,
        };
    } catch (error) {
        return {
            check: check('fail', `responsiveness probe threw ${normalizeError(error)}`),
            ticks,
            batchItems: items.length,
            elapsedMs: Math.trunc(nowMs() - startedAt),
        };
    } finally {
        clearInterval(interval);
    }
}

export async function runNativeCryptoWorkerProbe(
    options: RunNativeCryptoWorkerProbeOptions = {},
): Promise<NativeCryptoWorkerProbeReport> {
    const worker = options.worker ?? createNativeCryptoWorker();
    const expectedBatchSource = options.expectedBatchSource ?? 'native';
    const requireJsResponsiveness = options.requireJsResponsiveness ?? true;
    const responsivenessBatchSize = options.responsivenessBatchSize ?? 4_096;
    let capabilityError: string | null = null;
    const capability = await worker.probe().catch((error): NativeCryptoWorkerCapability => {
        capabilityError = normalizeError(error);
        return {
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unknown,
            supportedOperations: [],
        };
    });
    const supportedOperations = capability.supportedOperations ?? [];
    const capabilityEvidence = {
        available: capability.available,
        failureReason: capability.failureReason,
        nativeVersion: capability.nativeVersion ?? null,
        warmupMs: capability.warmupMs ?? null,
        supportedOperations,
    };

    const moduleAvailable = capability.available
        && supportedOperationsMatch(supportedOperations)
        && (expectedBatchSource !== 'native' || (capability.nativeVersion ?? 0) > 0);

    let dataKeyResult: NativeCryptoWorkerBatchOk<string | null> | null = null;
    let secretboxResult: NativeCryptoWorkerBatchOk<unknown | null> | null = null;
    let aesGcmResult: NativeCryptoWorkerBatchOk<unknown | null> | null = null;
    let dataKeyError: string | null = null;
    let secretboxError: string | null = null;
    let aesGcmError: string | null = null;

    const dataKeyExpected = buildExpectedDataKeyItems();
    const secretboxExpected = buildExpectedSecretboxItems();
    const aesGcmExpected = buildExpectedAesGcmItems();

    try {
        dataKeyResult = okResult(await worker.decryptDataKeyEnvelopeV1({
            scope: probeScope,
            items: buildDataKeyItems(),
        }));
    } catch (error) {
        dataKeyError = normalizeError(error);
    }

    try {
        secretboxResult = okResult(await worker.decryptSecretboxJson({
            scope: probeScope,
            items: buildSecretboxItems(),
        }));
    } catch (error) {
        secretboxError = normalizeError(error);
    }

    try {
        aesGcmResult = okResult(await worker.decryptAesGcmJson({
            scope: probeScope,
            items: buildAesGcmItems(),
        }));
    } catch (error) {
        aesGcmError = normalizeError(error);
    }

    const batchSources = collectBatchSources([dataKeyResult, secretboxResult, aesGcmResult]);
    const dataKeyItems = dataKeyResult?.items ?? [];
    const secretboxItems = secretboxResult?.items ?? [];
    const aesGcmItems = aesGcmResult?.items ?? [];
    const dataKeyValidIndexes = [0, 1, 2, 3, 6] as const;
    const dataKeyInvalidIndexes = [4, 5] as const;
    const secretboxValidIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 10] as const;
    const secretboxInvalidIndexes = [8, 9] as const;
    const aesGcmValidIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 10] as const;
    const aesGcmInvalidIndexes = [8, 9] as const;
    const dataKeyPass = dataKeyResult !== null && resultItemsMatch(dataKeyItems, dataKeyExpected);
    const secretboxPass = secretboxResult !== null && resultItemsMatch(secretboxItems, secretboxExpected);
    const aesGcmPass = aesGcmResult !== null && resultItemsMatch(aesGcmItems, aesGcmExpected);
    const dataKeyInvalidNulls = countNullIndexes(dataKeyItems, dataKeyInvalidIndexes);
    const secretboxInvalidNulls = countNullIndexes(secretboxItems, secretboxInvalidIndexes);
    const aesGcmInvalidNulls = countNullIndexes(aesGcmItems, aesGcmInvalidIndexes);
    const invalidNulls = dataKeyInvalidNulls + secretboxInvalidNulls + aesGcmInvalidNulls;
    const dataKeyValidItems = countMatchingIndexes(dataKeyItems, dataKeyExpected, dataKeyValidIndexes);
    const secretboxValidItems = countMatchingIndexes(secretboxItems, secretboxExpected, secretboxValidIndexes);
    const aesGcmValidItems = countMatchingIndexes(aesGcmItems, aesGcmExpected, aesGcmValidIndexes);
    const validItemsAfterInvalid = [
        dataKeyItems[6] !== null && valuesMatch(dataKeyItems[6], dataKeyExpected[6]),
        secretboxItems[10] !== null && valuesMatch(secretboxItems[10], secretboxExpected[10]),
        aesGcmItems[10] !== null && valuesMatch(aesGcmItems[10], aesGcmExpected[10]),
    ].filter(Boolean).length;
    const invalidItemsPass = invalidNulls === invalidDataKeyItems + invalidSecretboxItems + invalidAesGcmItems
        && validItemsAfterInvalid === 3;
    const sourcePass = batchSources.length === 1 && batchSources[0] === expectedBatchSource;
    const jsResponsiveness = requireJsResponsiveness
        ? await measureJsResponsiveness(worker, responsivenessBatchSize)
        : {
            check: check('skipped', 'JS responsiveness probe disabled by caller'),
            ticks: 0,
            batchItems: 0,
            elapsedMs: 0,
        };

    const checks = {
        moduleAvailable: check(
            moduleAvailable ? 'pass' : 'fail',
            moduleAvailable
                ? `available with ${supportedOperations.length} operations`
                : `unavailable or missing operations; failureReason=${capability.failureReason}${capabilityError ? `; ${capabilityError}` : ''}`,
        ),
        batchSource: check(
            sourcePass ? 'pass' : 'fail',
            `expected ${expectedBatchSource}; observed ${batchSources.join(',') || 'none'}`,
        ),
        dataKey: check(dataKeyPass ? 'pass' : 'fail', dataKeyError ?? `${dataKeyValidItems} valid, ${dataKeyInvalidNulls} invalid nulls`),
        secretbox: check(secretboxPass ? 'pass' : 'fail', secretboxError ?? `${secretboxValidItems} valid, ${secretboxInvalidNulls} invalid nulls`),
        aesGcm: check(aesGcmPass ? 'pass' : 'fail', aesGcmError ?? `${aesGcmValidItems} valid, ${aesGcmInvalidNulls} invalid nulls`),
        invalidItems: check(
            invalidItemsPass ? 'pass' : 'fail',
            `${invalidNulls} invalid nulls; ${validItemsAfterInvalid} valid items after invalid inputs`,
        ),
        jsResponsive: jsResponsiveness.check,
    } as const;
    const status = Object.values(checks).some((probeCheck) => probeCheck.status === 'fail') ? 'fail' : 'pass';

    return {
        status,
        checks,
        evidence: {
            batchSources,
            capability: capabilityEvidence,
            dataKey: { validItems: dataKeyValidItems, nullItems: dataKeyInvalidNulls },
            secretbox: { validItems: secretboxValidItems, nullItems: secretboxInvalidNulls },
            aesGcm: { validItems: aesGcmValidItems, nullItems: aesGcmInvalidNulls },
            invalidItems: { nullItems: invalidNulls, validItemsAfterInvalid },
            jsResponsiveness: {
                ticks: jsResponsiveness.ticks,
                batchItems: jsResponsiveness.batchItems,
                elapsedMs: jsResponsiveness.elapsedMs,
            },
        },
    };
}
