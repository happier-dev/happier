import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureMock = vi.hoisted(() => vi.fn());
const identifyMock = vi.hoisted(() => vi.fn());

vi.mock('./tracking', () => ({
    tracking: { capture: captureMock, identify: identifyMock },
}));

import { initializeTracking, trackAuthEnrollmentTransientRetry } from './index';

describe('auth enrollment tracking', () => {
    beforeEach(() => {
        captureMock.mockReset();
    });

    it('records a transient QR retry with only fixed, secret-free labels', () => {
        trackAuthEnrollmentTransientRetry();

        expect(captureMock).toHaveBeenCalledWith('auth_enrollment_outcome', {
            flow: 'account_qr',
            outcome: 'transient_retry',
        });
    });

    it('identifies the person by the anonymous id alone', () => {
        initializeTracking('anon-0123456789abcdef');

        expect(identifyMock).toHaveBeenCalledWith('anon-0123456789abcdef');
    });
});
