import { describe, expect, it } from 'vitest';

import { createNativeCryptoWorker } from './nativeCryptoWorker.web';
import { NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON } from './types';

describe('createNativeCryptoWorker web', () => {
    it('reports unavailable without attempting native work', async () => {
        const worker = createNativeCryptoWorker();

        // `unsupportedPlatform`, not `missing`: web has no native worker by design, so the JS path
        // is the intended implementation here and must not be reported as a degraded native build.
        expect(await worker.probe()).toEqual({
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform,
        });
    });
});
