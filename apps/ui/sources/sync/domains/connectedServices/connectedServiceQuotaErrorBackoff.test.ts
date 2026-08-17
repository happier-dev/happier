import { describe, expect, it } from 'vitest';

import {
    CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MAX_MS,
    CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MIN_MS,
    computeConnectedServiceQuotaErrorBackoffMs,
} from './connectedServiceQuotaErrorBackoff';

describe('computeConnectedServiceQuotaErrorBackoffMs', () => {
    it('never retries faster than the minimum, even at zero or negative counts', () => {
        expect(computeConnectedServiceQuotaErrorBackoffMs(0)).toBe(CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MIN_MS);
        expect(computeConnectedServiceQuotaErrorBackoffMs(1)).toBe(CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MIN_MS);
        expect(computeConnectedServiceQuotaErrorBackoffMs(-3)).toBe(CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MIN_MS);
    });

    it('doubles per consecutive failure so a broken account stops being hammered', () => {
        expect(computeConnectedServiceQuotaErrorBackoffMs(2)).toBe(60_000);
        expect(computeConnectedServiceQuotaErrorBackoffMs(3)).toBe(120_000);
        expect(computeConnectedServiceQuotaErrorBackoffMs(4)).toBe(240_000);
    });

    it('clamps at the maximum instead of growing without bound', () => {
        expect(computeConnectedServiceQuotaErrorBackoffMs(5)).toBe(CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MAX_MS);
        expect(computeConnectedServiceQuotaErrorBackoffMs(50)).toBe(CONNECTED_SERVICE_QUOTA_ERROR_BACKOFF_MAX_MS);
    });
});
