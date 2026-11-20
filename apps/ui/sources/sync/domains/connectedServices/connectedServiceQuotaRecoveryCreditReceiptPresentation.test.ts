import { describe, expect, it } from 'vitest';

import {
    readConnectedServiceQuotaRecoveryCreditActionPresentation,
    resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey,
} from './connectedServiceQuotaRecoveryCreditReceiptPresentation';

describe('readConnectedServiceQuotaRecoveryCreditActionPresentation', () => {
    it('keeps observed unavailability uncertain when the owner cannot confirm the debit', () => {
        const presentation = readConnectedServiceQuotaRecoveryCreditActionPresentation({
            ok: false,
            errorCode: 'outcome_unknown',
            error: 'The grant is no longer available; its use could not be confirmed.',
            details: { receipt: {
                idempotencyKey: 'approved-reset',
                providerCreditId: 'grant-a',
                status: 'not_available',
            } },
        });

        expect(presentation.outcome).toEqual({ kind: 'unknown', errorCode: 'outcome_unknown' });
    });
});

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
