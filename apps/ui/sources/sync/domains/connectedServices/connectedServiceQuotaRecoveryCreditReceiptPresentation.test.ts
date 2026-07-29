import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey } from './connectedServiceQuotaRecoveryCreditReceiptPresentation';

describe('resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey', () => {
    it('presents nothing_to_reset as neutral information and keeps other receipts silent', () => {
        expect(resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey('nothing_to_reset')).toBe(
            'connectedServices.quota.recoveryCreditNothingToReset',
        );
        expect(resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey('consumed')).toBeNull();
        expect(resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey('already_consumed')).toBeNull();
        expect(resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey('not_available')).toBeNull();
        expect(resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey('unknown_after_timeout')).toBeNull();
    });
});
