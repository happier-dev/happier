import { pathToFileURL } from 'node:url';

import sodium from 'libsodium-wrappers';

import {
    buildAesGcmJsonCases,
    buildDataKeyEnvelopeCases,
    buildSecretboxJsonCases,
    decryptAesGcmJsonCase,
    decryptDataKeyEnvelopeCase,
    decryptSecretboxJsonCase,
} from './cryptoWorkerMalformedInputFuzzOperations';
import {
    DEFAULT_FUZZ_SEED,
    type CryptoWorkerMalformedInputFuzzSummary,
    createPrng,
    normalizeIterations,
    summarizeCases,
} from './cryptoWorkerMalformedInputFuzzShared';

export async function runCryptoWorkerMalformedInputFuzz(
    options: Readonly<{ iterations?: number; seed?: number }> = {},
): Promise<CryptoWorkerMalformedInputFuzzSummary> {
    const iterations = normalizeIterations(options.iterations);
    const seed = options.seed ?? DEFAULT_FUZZ_SEED;
    const prng = createPrng(seed);
    await sodium.ready;

    return {
        schema: 'happier.cryptoWorkerMalformedInputFuzz.v1',
        seed,
        iterations,
        dataKeyEnvelopeV1: await summarizeCases(
            buildDataKeyEnvelopeCases(iterations, prng),
            decryptDataKeyEnvelopeCase,
        ),
        secretboxJson: await summarizeCases(
            buildSecretboxJsonCases(iterations, prng),
            decryptSecretboxJsonCase,
        ),
        aesGcmJson: await summarizeCases(
            buildAesGcmJsonCases(iterations, prng),
            decryptAesGcmJsonCase,
        ),
    };
}

function parseCliOptions(argv: readonly string[]): Readonly<{ iterations?: number; seed?: number }> {
    const options: { iterations?: number; seed?: number } = {};
    for (const arg of argv) {
        if (arg.startsWith('--iterations=')) {
            options.iterations = Number(arg.slice('--iterations='.length));
        } else if (arg.startsWith('--seed=')) {
            options.seed = Number(arg.slice('--seed='.length));
        }
    }
    return options;
}

async function main(): Promise<void> {
    const summary = await runCryptoWorkerMalformedInputFuzz(parseCliOptions(process.argv.slice(2)));
    console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    });
}
