import { describe, expect, it } from 'vitest';

import { runCryptoWorkerMalformedInputFuzz } from './fuzzCryptoWorkerMalformedInputs';

describe('runCryptoWorkerMalformedInputFuzz', () => {
    it('keeps malformed decrypt batches null-isolated and length-preserving', async () => {
        const summary = await runCryptoWorkerMalformedInputFuzz({
            iterations: 6,
            seed: 0xdec0de,
        });

        expect(summary.schema).toBe('happier.cryptoWorkerMalformedInputFuzz.v1');
        expect(summary.iterations).toBe(6);
        expect(summary.dataKeyEnvelopeV1).toMatchObject({
            inputItems: 10,
            nullItems: 8,
            validItems: 2,
            validItemsAfterInvalid: 1,
        });
        expect(summary.secretboxJson).toMatchObject({
            inputItems: 10,
            nullItems: 8,
            validItems: 2,
            validItemsAfterInvalid: 1,
        });
        expect(summary.aesGcmJson).toMatchObject({
            inputItems: 10,
            nullItems: 8,
            validItems: 2,
            validItemsAfterInvalid: 1,
        });
    });
});
