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

    it('classifies canonical upgrade-required socket failures as terminal compatibility failures', () => {
        const error = Object.assign(new Error('upgrade required'), {
            data: {
                error: 'client-upgrade-required',
                requirement: {
                    v: 1,
                    minimumSessionSyncProtocolVersion: 2,
                    clientKind: 'session-runner',
                    minimumAppVersion: '9.0.0',
                    updateUrl: null,
                },
            },
        });
        expect(classifySessionTransportErrorToProbeResult(error)).toEqual({
            status: 'auth_failed',
            statusCode: 426,
            errorMessage: 'This Happier session runner must be upgraded before it can sync sessions.',
        });
    });

    it('classifies the server RPC registration error envelope as terminal compatibility failure', () => {
        expect(classifySessionTransportErrorToProbeResult({
            type: 'register',
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                minimumSessionSyncProtocolVersion: 2,
                clientKind: 'session-runner',
                minimumAppVersion: '9.0.0',
                updateUrl: null,
            },
        })).toEqual({
            status: 'auth_failed',
            statusCode: 426,
            errorMessage: 'This Happier session runner must be upgraded before it can sync sessions.',
        });
    });
});
