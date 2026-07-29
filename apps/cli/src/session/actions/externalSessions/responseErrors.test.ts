import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';

const { debugLog } = vi.hoisted(() => ({
    debugLog: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: debugLog,
    },
}));

import {
    internalErrorResponse,
    logExternalSessionsInternalError,
    mapActionFailureToExternalSessionsError,
    mapExternalSessionProviderFailureToExternalSessionsError,
    mapExternalTakeoverResultToDirectTakeoverResponse,
} from './responseErrors';

const SENTINELS = [
    '/Users/alice/private/session.jsonl',
    'provider-secret-message',
    'transcript-secret-content',
    'claim-secret-id',
    'token-secret-value',
] as const;

function expectNoSentinels(value: unknown): void {
    const serialized = JSON.stringify(value);
    for (const sentinel of SENTINELS) {
        expect(serialized).not.toContain(sentinel);
    }
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});

describe('External Sessions structural error diagnostics', () => {
    it('logs Error failures without message, stack, cause, request, source, link, claim, transcript, path, or token data even in DEBUG', () => {
        vi.stubEnv('DEBUG', '1');
        const error = Object.assign(
            new Error(
                `filesystem failed at ${SENTINELS[0]}: ${SENTINELS[1]}`,
                {
                    cause: {
                        transcript: SENTINELS[2],
                        token: SENTINELS[4],
                    },
                },
            ),
            {
                request: { token: SENTINELS[4] },
                source: { path: SENTINELS[0] },
                link: { claim: SENTINELS[3] },
                transcript: SENTINELS[2],
            },
        );

        logExternalSessionsInternalError('external_session.test_failure', error);

        expect(debugLog).toHaveBeenCalledWith(
            '[externalSessions][internal_error]',
            {
                context: 'external_session.test_failure',
                errorCode: 'internal_error',
                errorKind: 'error',
            },
        );
        expectNoSentinels(debugLog.mock.calls);
    });

    it('never serializes an arbitrary non-Error rejection object', () => {
        vi.stubEnv('DEBUG', '1');
        const rejection = {
            message: SENTINELS[1],
            cause: { path: SENTINELS[0] },
            request: { token: SENTINELS[4] },
            source: { transcript: SENTINELS[2] },
            link: { claim: SENTINELS[3] },
        };

        logExternalSessionsInternalError('external_session.object_failure', rejection);

        expect(debugLog).toHaveBeenCalledWith(
            '[externalSessions][internal_error]',
            {
                context: 'external_session.object_failure',
                errorCode: 'internal_error',
                errorKind: 'non_error',
            },
        );
        expectNoSentinels(debugLog.mock.calls);
    });

    it('does not accept path-like failure data as a log context', () => {
        logExternalSessionsInternalError(SENTINELS[0], new Error(SENTINELS[1]));

        expect(debugLog).toHaveBeenCalledWith(
            '[externalSessions][internal_error]',
            {
                context: 'external_session.internal_error',
                errorCode: 'internal_error',
                errorKind: 'error',
            },
        );
        expectNoSentinels(debugLog.mock.calls);
    });

    it('retains only the normalized Agent failure class and retryability', () => {
        const error = Object.assign(new ExternalSessionProviderFailureError({
            code: 'provider_error',
            message: SENTINELS[1],
            operation: `read:${SENTINELS[0]}`,
            retryable: true,
        }), {
            request: { token: SENTINELS[4] },
            transcript: SENTINELS[2],
        });

        logExternalSessionsInternalError('external_session.agent_failure', error);

        expect(debugLog).toHaveBeenCalledWith(
            '[externalSessions][internal_error]',
            {
                context: 'external_session.agent_failure',
                errorCode: 'agent_unavailable',
                errorKind: 'agent_failure',
                retryable: true,
            },
        );
        expectNoSentinels(debugLog.mock.calls);
    });

    it('does not expose provider or action failure messages in outward diagnostics', () => {
        const providerFailure = new ExternalSessionProviderFailureError({
            code: 'provider_error',
            message: `${SENTINELS[1]} ${SENTINELS[0]} ${SENTINELS[4]}`,
            operation: `read:${SENTINELS[2]}`,
        });

        expect(
            mapExternalSessionProviderFailureToExternalSessionsError(providerFailure),
        ).toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'agent_unavailable',
        });
        expect(mapActionFailureToExternalSessionsError({
            ok: false,
            errorCode: 'action_failed',
            error: `${SENTINELS[2]} ${SENTINELS[3]} ${SENTINELS[4]}`,
        })).toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'internal_error',
        });
    });

    it('does not expose takeover failure details in outward diagnostics', () => {
        const result = mapExternalTakeoverResultToDirectTakeoverResponse({
            ok: false,
            errorCode: 'spawn_failed',
            error: `${SENTINELS[0]} ${SENTINELS[2]} ${SENTINELS[4]}`,
        });

        expect(result).toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'spawn_failed',
        });
        expectNoSentinels(result);
    });

    it('keeps outward internal-error diagnostics on the explicit safe code', () => {
        const result = internalErrorResponse(
            'external_session.outward_failure',
            new Error(`${SENTINELS[1]} ${SENTINELS[0]}`),
            'external_session_operation_failed',
        );

        expect(result).toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'external_session_operation_failed',
        });
        expectNoSentinels({ result, calls: debugLog.mock.calls });
    });
});
