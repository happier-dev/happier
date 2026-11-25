import { HomeCarrierPolicyError } from '@happier-dev/cli-common/homeEnrollment';
import { acquireHomeCarrierByPolicy } from '@happier-dev/cli-common/homeEnrollment';
import { describe, expect, it } from 'vitest';

import { resolveHomeAdmissionConnectionSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';

import { homeAdmissionCarrierVerdict } from './homeAdmissionReadiness';

describe('cold Home carrier refusal', () => {
    it('keeps the policy owner’s invalid preference as a refusal without Retry', async () => {
        const result = await acquireHomeCarrierByPolicy({
            applicationCarrierEligibility: 'automatic',
            preferredTransport: 'iroh',
            descriptor: { v: 1, homeServerIdentityId: 'srv_preference',
                canonicalServerUrl: 'https://preference.example.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://preference.example.test' }] },
            async acquireIroh() { throw new Error('Preference must be checked first'); },
            classifyFailure: () => { throw new Error('Preference is a policy refusal'); },
        });
        if (result.kind !== 'fail_closed') throw new Error('Expected a policy refusal');
        const verdict = homeAdmissionCarrierVerdict(result);
        expect(verdict).toEqual({ kind: 'fail_closed', code: 'invalid_preference', fallbackAllowed: false, retryable: false });
        expect(resolveHomeAdmissionConnectionSummary(verdict)?.action).toBe('none');
    });

    it.each([true, false])('preserves a typed fail_closed result with fallbackAllowed=%s', fallbackAllowed => {
        const verdict = homeAdmissionCarrierVerdict({
            kind: 'fail_closed', fallbackAllowed,
            error: new HomeCarrierPolicyError('identity_mismatch', 'Details belong to the transport owner'),
        });
        expect(verdict).toEqual({ kind: 'fail_closed', code: 'identity_mismatch', fallbackAllowed, retryable: false });
        expect(resolveHomeAdmissionConnectionSummary(verdict)?.action).toBe('none');
    });
});
