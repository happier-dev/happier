import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ExternalSessionFollowFailureError,
} from '@/session/external/externalSessionFollowFailure';
import { ExternalSessionProviderFailureError } from '@/session/external/providerOps';
import { isAgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';
import { ExternalSessionPersistedTakeoverPreflightError } from './materializeAction';

const { debugLog } = vi.hoisted(() => ({
    debugLog: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: debugLog,
    },
}));

import {
    ExternalSessionTakeoverAdmissionInvariantError,
    internalErrorResponse,
    logExternalSessionsInternalError,
    logExternalSessionSourceDiscontinuity,
    mapExternalSessionCorridorFailureToExternalSessionsError,
    mapActionFailureToExternalSessionsError,
    mapExternalSessionProviderFailureToExternalSessionsError,
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
    it('preserves a lost creation receipt and its safe transport cause without exposing the HTTP payload', () => {
        const error = Object.assign(new Error(SENTINELS[1]), {
            code: 'outcome_unknown',
            cause: { code: 'ECONNABORTED', message: SENTINELS[2], config: { token: SENTINELS[4] } },
        });
        expect(mapExternalSessionCorridorFailureToExternalSessionsError(error)).toEqual({
            ok: false, errorCode: 'internal_error', error: 'external_session_outcome_unknown',
        });
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][internal_error]', expect.objectContaining({
            code: 'outcome_unknown', causeCode: 'ECONNABORTED', transportKind: 'timeout',
        }));
        expectNoSentinels(debugLog.mock.calls);
        debugLog.mockClear();
        expect(mapExternalSessionCorridorFailureToExternalSessionsError(Object.assign(new Error(SENTINELS[1]), {
            code: 'outcome_unknown', cause: { code: SENTINELS[4] },
        }))).not.toBeNull();
        expectNoSentinels(debugLog.mock.calls);
        expect(debugLog.mock.calls[0]?.[1]).not.toHaveProperty('causeCode');
        expect(mapExternalSessionCorridorFailureToExternalSessionsError(new Error('ordinary host defect'))).toBeNull();
    });

    it('answers an unsupported session format with its own typed code and the safe format token, for any Agent', () => {
        expect(isAgentExternalSessionsFailureCode('format_unsupported')).toBe(true);
        expect(mapExternalSessionProviderFailureToExternalSessionsError(new ExternalSessionProviderFailureError({
            code: 'format_unsupported', operation: 'pageTranscript', retryable: false,
            message: 'cursor_cli_store_format_unsupported',
        }))).toEqual({ ok: false, errorCode: 'agent_format_unsupported', error: 'cursor_cli_store_format_unsupported', retryable: false });
        // A free-form Agent message never crosses as the format token.
        expect(mapExternalSessionProviderFailureToExternalSessionsError(new ExternalSessionProviderFailureError({
            code: 'format_unsupported', operation: 'listCandidates', retryable: false, message: SENTINELS[0],
        }))).toEqual({ ok: false, errorCode: 'agent_format_unsupported', error: 'agent_format_unsupported', retryable: false });
        expectNoSentinels(debugLog.mock.calls);
    });

    it('names transcript producer overflow through the exact safe-token owner without leaking failure prose', () => {
        mapExternalSessionProviderFailureToExternalSessionsError(new ExternalSessionProviderFailureError({
            code: 'agent_error', operation: 'pageTranscript', retryable: false,
            message: 'external_sessions_transcript_item_byte_budget',
        }));
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
            reason: 'transcript_item_byte_budget', failureClass: 'result_admission',
        }));
        debugLog.mockClear();
        mapExternalSessionProviderFailureToExternalSessionsError(new ExternalSessionProviderFailureError({
            code: 'agent_error', operation: 'pageTranscript', message: SENTINELS[0],
        }));
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
            reason: 'transcript_agent_failure',
        }));
        expectNoSentinels(debugLog.mock.calls);
    });
    it('retains schema-owned spawn codes and detail kinds without their private payloads', () => {
        const failure = {
            type: 'error',
            errorCode: 'SPAWN_VALIDATION_FAILED',
            errorMessage: SENTINELS[1],
            errorDetail: { kind: 'provider_error', message: SENTINELS[2], path: SENTINELS[0] },
        };
        logExternalSessionsInternalError('external_session.takeover_admission.spawn', failure);
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][internal_error]', {
            context: 'external_session.takeover_admission.spawn',
            errorCode: 'SPAWN_VALIDATION_FAILED',
            errorKind: 'spawn_failure',
            detailKind: 'provider_error',
        });
        logExternalSessionsInternalError('external_session.takeover_admission.spawn', {
            ...failure, errorCode: SENTINELS[4], errorDetail: { kind: SENTINELS[0] },
        });
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][internal_error]', {
            context: 'external_session.takeover_admission.spawn',
            errorCode: 'internal_error',
            errorKind: 'non_error',
        });
        expectNoSentinels(debugLog.mock.calls);
    });

    it('logs only closed admission invariant codes and rejects forged code fields', () => {
        const error = Object.assign(new ExternalSessionTakeoverAdmissionInvariantError(
            'persisted_takeover_admission_authority_mismatch',
        ), { message: SENTINELS[1], cause: { token: SENTINELS[4] } });
        logExternalSessionsInternalError('external_session.takeover_admission.prepare_spawn', error);
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][internal_error]', {
            context: 'external_session.takeover_admission.prepare_spawn',
            errorCode: 'persisted_takeover_admission_authority_mismatch',
            errorKind: 'takeover_admission_invariant',
        });
        Object.assign(error, { code: SENTINELS[0] });
        logExternalSessionsInternalError('external_session.takeover_admission.prepare_spawn', error);
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][internal_error]', expect.objectContaining({
            context: 'external_session.takeover_admission.prepare_spawn',
            errorCode: 'internal_error',
            errorKind: 'error',
        }));
        expectNoSentinels(debugLog.mock.calls);
    });

    it('retains a typed takeover preflight code while keeping its private details out of diagnostics', () => {
        const error = new ExternalSessionPersistedTakeoverPreflightError(
            'not_allowed',
            `${SENTINELS[0]} ${SENTINELS[1]} ${SENTINELS[4]}`,
        );

        logExternalSessionsInternalError('external_session.takeover_admission.prepare_spawn', error);

        expect(debugLog).toHaveBeenCalledWith('[externalSessions][internal_error]', {
            context: 'external_session.takeover_admission.prepare_spawn',
            errorCode: 'not_allowed',
            errorKind: 'takeover_preflight',
        });
        expectNoSentinels(debugLog.mock.calls);
    });

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
                errorName: 'Error',
                frames: expect.any(Array),
            },
        );
        expectNoSentinels(debugLog.mock.calls);
    });

    it('locates a plain Error by its name, safe code and message-free stack frames', () => {
        function failingAttachStep(): never {
            throw Object.assign(new TypeError(`bad read of ${SENTINELS[0]}\n    at forged (${SENTINELS[1]})`), {
                code: 'ERR_TEST_CODE',
            });
        }
        let thrown: unknown;
        try {
            failingAttachStep();
        } catch (error) {
            thrown = error;
        }

        logExternalSessionsInternalError('external_session_attach', thrown);

        const [, fields] = debugLog.mock.calls[0]!;
        expect(fields).toMatchObject({
            context: 'external_session_attach',
            errorCode: 'internal_error',
            errorKind: 'error',
            errorName: 'TypeError',
            code: 'ERR_TEST_CODE',
        });
        expect(fields.frames[0]).toContain('failingAttachStep');
        expect(fields.frames.length).toBeLessThanOrEqual(8);
        expectNoSentinels(debugLog.mock.calls);
    });

    it('drops an unsafe code and a forged name instead of logging them', () => {
        const error = Object.assign(new Error(SENTINELS[1]), { code: SENTINELS[0] });
        error.name = SENTINELS[2];

        logExternalSessionsInternalError('external_session_attach', error);

        const [, fields] = debugLog.mock.calls[0]!;
        expect(fields.code).toBeUndefined();
        expect(fields.errorName).toBe('Error');
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
            expect.objectContaining({
                context: 'external_session.internal_error',
                errorCode: 'internal_error',
                errorKind: 'error',
            }),
        );
        expectNoSentinels(debugLog.mock.calls);
    });

    it('logs the closed host admission reason on the daemon failure path', () => {
        mapExternalSessionProviderFailureToExternalSessionsError(new ExternalSessionProviderFailureError({
            code: 'agent_error', message: 'external_sessions_native_cursor_too_large', operation: 'listCandidates',
        }));
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
            failureClass: 'result_admission', reason: 'native_cursor_too_large',
        }));
        expectNoSentinels(debugLog.mock.calls);
    });

    it.each(['source_identity_changed', 'unfinished_file_missing', 'path_authority', 'frontier_anchor', 'transcript_unsupported_record'])('logs a closed source failure reason: %s', reason => {
        mapExternalSessionProviderFailureToExternalSessionsError(new ExternalSessionProviderFailureError({
            code: 'source_invalid', message: `external_sessions_${reason}`, operation: 'listCandidates', retryable: true,
        }));
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
            failureClass: 'source_validity', reason,
        }));
        expectNoSentinels(debugLog.mock.calls);
    });

    it('logs source discontinuity without forwarding arbitrary diagnostic codes', () => {
        logExternalSessionSourceDiscontinuity([{ code: SENTINELS[0] }]);
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
            code: 'source_discontinuity', reason: 'transcript_truncated',
        }));
        logExternalSessionSourceDiscontinuity([{ code: `external_sessions_source_identity_changed:${SENTINELS[1]}` },
            { code: 'external_sessions_source_identity_changed' }]);
        expect(debugLog).toHaveBeenLastCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
            code: 'source_discontinuity', reason: 'source_identity_changed',
        }));
        expectNoSentinels(debugLog.mock.calls);
    });

    it('retains only the normalized Agent failure class and retryability', () => {
        const error = Object.assign(new ExternalSessionProviderFailureError({
            code: 'agent_error',
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
                errorCode: 'agent_error',
                errorKind: 'agent_failure',
                retryable: true,
            },
        );
        expectNoSentinels(debugLog.mock.calls);
    });

    it('does not expose provider or action failure messages in outward diagnostics', () => {
        const providerFailure = new ExternalSessionProviderFailureError({
            code: 'agent_error',
            message: `${SENTINELS[1]} ${SENTINELS[0]} ${SENTINELS[4]}`,
            operation: `read:${SENTINELS[2]}`,
            retryable: true,
        });

        expect(
            mapExternalSessionProviderFailureToExternalSessionsError(providerFailure),
        ).toEqual({
            ok: false,
            errorCode: 'agent_error',
            error: 'agent_error',
            retryable: true,
        });
        expect(debugLog).toHaveBeenCalledWith('[externalSessions][agent_failure]', {
            code: 'agent_error',
            errorCode: 'agent_error',
            retryable: true,
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

    it('classifies each corridor failure class and leaves anything else to the internal-error envelope', () => {
        expect(mapExternalSessionCorridorFailureToExternalSessionsError(
            new ExternalSessionFollowFailureError(
                'follow_unavailable',
                `live follow unavailable for ${SENTINELS[0]}`,
            ),
        )).toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_follow_unavailable',
            retryable: false,
        });
        expect(mapExternalSessionCorridorFailureToExternalSessionsError(
            new ExternalSessionFollowFailureError('source_changed', SENTINELS[0]),
        )).toEqual({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_source_changed',
            retryable: true,
        });
        expect(mapExternalSessionCorridorFailureToExternalSessionsError(
            new ExternalSessionProviderFailureError({
                code: 'source_invalid',
                message: SENTINELS[1],
                operation: 'validateSource',
            }),
        )).toEqual({
            ok: false,
            errorCode: 'invalid_request',
            error: 'invalid_request',
            retryable: false,
        });
        expect(mapExternalSessionCorridorFailureToExternalSessionsError(
            new Error(`unexpected defect at ${SENTINELS[0]}`),
        )).toBeNull();
        expectNoSentinels(
            mapExternalSessionCorridorFailureToExternalSessionsError(
                new ExternalSessionFollowFailureError('agent_unavailable', SENTINELS[0]),
            ),
        );
    });

    it('answers a host-owned conflict and an unrecognized failure code with the internal-error outcome', () => {
        expect(mapExternalSessionCorridorFailureToExternalSessionsError(
            new ExternalSessionProviderFailureError({
                code: 'conflict',
                message: SENTINELS[1],
                operation: 'externalSession.lookupByTags',
            }),
        )).toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'internal_error',
            retryable: false,
        });
        expect(mapExternalSessionProviderFailureToExternalSessionsError(
            new ExternalSessionProviderFailureError({
                code: 'not_a_contribution_failure_code',
                message: SENTINELS[1],
                operation: 'pageTranscript',
            }),
        )).toEqual({
            ok: false,
            errorCode: 'internal_error',
            error: 'internal_error',
            retryable: false,
        });
    });

    it('keeps a timeout, an Agent fault and an unavailable Agent on distinct outcomes', () => {
        const outcomes: ReadonlyArray<readonly [string, string]> = [
            ['timeout', 'agent_timeout'],
            ['agent_error', 'agent_error'],
            ['agent_unavailable', 'agent_unavailable'],
            ['source_unreachable', 'agent_unavailable'],
            ['unsupported', 'agent_unavailable'],
            ['unavailable', 'agent_unavailable'],
            ['not_authorized', 'agent_unavailable'],
            ['cancelled', 'agent_unavailable'],
        ];
        for (const [code, errorCode] of outcomes) {
            expect(isAgentExternalSessionsFailureCode(code)).toBe(true);
            expect(mapExternalSessionProviderFailureToExternalSessionsError(
                new ExternalSessionProviderFailureError({
                    code,
                    message: SENTINELS[1],
                    operation: 'pageTranscript',
                    retryable: code === 'timeout',
                }),
            )).toEqual({
                ok: false,
                errorCode,
                error: errorCode,
                retryable: code === 'timeout',
            });
        }
        expect(isAgentExternalSessionsFailureCode('conflict')).toBe(false);
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
