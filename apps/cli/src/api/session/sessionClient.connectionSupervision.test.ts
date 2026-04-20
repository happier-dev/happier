import { describe, expect, it } from 'vitest';

import { HttpStatusError } from '@/api/client/httpStatusError';

import { classifySessionTransportErrorToProbeResult } from './sessionClient';

describe('ApiSessionClient connection supervision', () => {
    it('classifies terminal pre-socket auth failures as auth_failed for the session supervisor', () => {
        expect(classifySessionTransportErrorToProbeResult(new HttpStatusError(401, 'expired token'))).toEqual({
            status: 'auth_failed',
            statusCode: 401,
            errorMessage: 'expired token',
        });
    });

    it('ignores non-auth transport failures so the supervisor can keep retry policy ownership', () => {
        expect(classifySessionTransportErrorToProbeResult(new Error('socket timeout'))).toBeNull();
    });
});
