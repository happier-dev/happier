import { describe, expect, it } from 'vitest';

import { resolveSocketErrorClassification } from './resolveSocketErrorClassification';

describe('resolveSocketErrorClassification', () => {
    it('treats socket errors with data.statusCode=401 as auth failures', () => {
        const error = Object.assign(new Error('invalid-token'), {
            data: {
                statusCode: 401,
                error: 'invalid-token',
            },
        });

        expect(resolveSocketErrorClassification(error)).toEqual({
            message: 'invalid-token',
            statusCode: 401,
            kind: 'auth',
            retryable: false,
        });
    });

    it('treats socket errors with data.status=403 as auth failures (legacy)', () => {
        const error = Object.assign(new Error('missing-scope'), {
            data: {
                status: 403,
            },
        });

        expect(resolveSocketErrorClassification(error)).toEqual({
            message: 'missing-scope',
            statusCode: 403,
            kind: 'auth',
            retryable: false,
        });
    });

    it('treats unknown socket errors as retryable unknown', () => {
        expect(resolveSocketErrorClassification(new Error('xhr poll error'))).toEqual({
            message: 'Connection error',
            statusCode: null,
            kind: 'unknown',
            retryable: true,
        });
    });
});
