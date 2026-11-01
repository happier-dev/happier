import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    classifyMicSessionFailure,
    classifyRealtimeProviderFailure,
    classifyVoiceMachineError,
    createVoiceMachineError,
    isVoiceMachineErrorKind,
    resolveVoiceMachineErrorKind,
} from './voiceMachineError';

describe('createVoiceMachineError', () => {
    it('keeps an unavailable Agent selection actionable without a provider Retry', () => {
        expect(classifyVoiceMachineError(Object.assign(new Error('voice_agent_selection_unavailable'), {
            code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
        }), { kind: 'provider_error' })).toMatchObject({ kind: 'provider_setup_required',
            reason: 'voice_agent_selection_unavailable', recoveryAction: 'open_settings', presentation: 'error' });
    });
    it.each(['VOICE_AGENT_TARGET_MACHINE_OFFLINE', 'VOICE_AGENT_TARGET_MACHINE_KEY_UNAVAILABLE', 'daemon_streaming_stt_machine_unreachable'])(
        'keeps the unavailable Machine remedy for %s instead of a generic provider retry', (reason) => {
            expect(resolveVoiceMachineErrorKind(reason, 'provider_error')).toBe('execution_machine_unavailable');
        },
    );
    it('projects an installed-client setup refusal through the existing visible setup policy', () => {
        const error = Object.assign(new Error('voice_text_segmentation_unavailable'), { code: 'provider_setup_required' });
        expect(classifyVoiceMachineError(error)).toMatchObject({
            kind: 'provider_setup_required', reason: 'voice_text_segmentation_unavailable',
            phase: 'preflight', presentation: 'error', recoverable: false,
        });
    });
    it('requires a Voice model change when the Session uses unsupported Team credentials', () => {
        expect(classifyVoiceMachineError(Object.assign(new Error('Voice does not support Team credential models.'), {
            code: 'VOICE_AGENT_TEAM_MODEL_UNSUPPORTED',
        }))).toMatchObject({ kind: 'provider_setup_required', phase: 'preflight',
            recoveryAction: 'open_settings', presentation: 'error', recoverable: false });
        expect(resolveVoiceMachineErrorKind('VOICE_AGENT_TEAM_MODEL_UNSUPPORTED', 'provider_error'))
            .toBe('provider_setup_required');
    });
    it('mints complete structured policy for a preflight microphone denial', () => {
        expect(createVoiceMachineError({ kind: 'mic_permission_denied', reason: 'denied' })).toEqual({
            kind: 'mic_permission_denied',
            reason: 'denied',
            phase: 'preflight',
            retryPolicy: 'user_action',
            recoveryAction: 'open_settings',
            presentation: 'permission_required',
            // A blocked microphone stays on screen as "Microphone blocked" with Allow (lab ST): a
            // recoverable failure projects as a graceful disconnect, which the presence draws as rest.
            recoverable: false,
        });
    });

    it('fails a missing microphone visibly with a retry, never as a permission question', () => {
        expect(createVoiceMachineError({ kind: 'mic_unavailable', reason: 'mic_unavailable' })).toEqual({
            kind: 'mic_unavailable',
            reason: 'mic_unavailable',
            phase: 'preflight',
            retryPolicy: 'user_action',
            recoveryAction: 'retry',
            presentation: 'error',
            recoverable: false,
        });
        expect(classifyVoiceMachineError(Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' })))
            .toMatchObject({ kind: 'mic_unavailable', presentation: 'error' });
        expect(classifyVoiceMachineError(new Error('mic_unavailable'))).toMatchObject({ kind: 'mic_unavailable' });
        expect(classifyRealtimeProviderFailure(Object.assign(new Error('no device'), { name: 'NotFoundError' })))
            .toMatchObject({ kind: 'mic_unavailable' });
    });

    it('mints complete structured policy for active-session microphone revocation', () => {
        expect(createVoiceMachineError({ kind: 'mic_permission_revoked', reason: 'revoked' })).toEqual({
            kind: 'mic_permission_revoked',
            reason: 'revoked',
            phase: 'active_session',
            retryPolicy: 'user_action',
            recoveryAction: 'open_settings_then_reconnect',
            presentation: 'error',
            recoverable: false,
        });
    });

    it('projects temporary service unavailability as a retryable preflight failure', () => {
        expect(classifyVoiceMachineError(Object.assign(new Error('voice_execution_machine_unavailable'), {
            code: 'VOICE_AGENT_TARGET_MACHINE_UNOBSERVED',
        }))).toMatchObject({ kind: 'service_temporarily_unavailable', phase: 'preflight',
            recoveryAction: 'retry', presentation: 'error', recoverable: false });
        expect(createVoiceMachineError({
            kind: 'service_temporarily_unavailable',
            reason: 'connected_service_credential_refresh_unavailable',
        })).toEqual({
            kind: 'service_temporarily_unavailable',
            reason: 'connected_service_credential_refresh_unavailable',
            phase: 'preflight',
            retryPolicy: 'user_action',
            recoveryAction: 'retry',
            // Visible like every other preflight refusal: a recoverable notice
            // projects as a graceful disconnect and renders as plain idle, so a
            // Start the host refused would tell the user nothing while this same
            // policy demands a user retry.
            presentation: 'error',
            recoverable: false,
        });
    });

    it('projects an unavailable execution machine to its existing settings recovery', () => {
        expect(createVoiceMachineError({
            kind: 'execution_machine_unavailable',
            reason: 'machine_unavailable',
        })).toEqual({
            kind: 'execution_machine_unavailable',
            reason: 'machine_unavailable',
            phase: 'preflight',
            retryPolicy: 'user_action',
            recoveryAction: 'select_execution_machine',
            presentation: 'error',
            recoverable: false,
        });
    });

    it.each([
        ['provider_setup_required', 'user_action', 'open_settings'],
        ['authentication_required', 'user_action', 'connect_agent'],
        ['session_unavailable', 'never', 'none'],
        ['unsupported_runtime', 'user_action', 'install_agent_runtime'],
        ['update_required', 'user_action', 'update_agent_runtime'],
        ['feature_unavailable', 'never', 'none'],
    ] as const)('keeps %s recovery truthful without collapsing it to retry', (kind, retryPolicy, recoveryAction) => {
        expect(createVoiceMachineError({ kind, reason: kind })).toMatchObject({
            kind,
            phase: 'preflight',
            retryPolicy,
            recoveryAction,
            presentation: 'error',
        });
    });

    it.each([
        'session_unavailable',
        'feature_unavailable',
    ] as const)('keeps the hard %s error non-recoverable until external state changes', (kind) => {
        expect(createVoiceMachineError({ kind, reason: kind })).toMatchObject({
            kind,
            retryPolicy: 'never',
            recoveryAction: 'none',
            recoverable: false,
        });
    });

    it('derives all policy fields from kind and does not accept caller overrides', () => {
        expectTypeOf<Parameters<typeof createVoiceMachineError>[0]>()
            .not.toHaveProperty('recoverable');
        expect(createVoiceMachineError({ kind: 'provider_error', reason: 'x' })).toEqual({
            kind: 'provider_error',
            reason: 'x',
            phase: 'runtime',
            retryPolicy: 'user_action',
            recoveryAction: 'retry',
            presentation: 'notice',
            recoverable: true,
        });
    });
});

describe('isVoiceMachineErrorKind', () => {
    it('accepts known kinds and rejects others', () => {
        expect(isVoiceMachineErrorKind('mic_plateau')).toBe(true);
        expect(isVoiceMachineErrorKind('tts_failed')).toBe(true);
        expect(isVoiceMachineErrorKind('execution_machine_unavailable')).toBe(true);
        expect(isVoiceMachineErrorKind('not_a_kind')).toBe(false);
        expect(isVoiceMachineErrorKind(42)).toBe(false);
    });
});

describe('classifyMicSessionFailure', () => {
    it('maps the mic failure kind straight onto a machine error', () => {
        expect(classifyMicSessionFailure({ kind: 'mic_ended', reason: 'device_lost' })).toEqual({
            kind: 'mic_ended',
            reason: 'device_lost',
            phase: 'active_session',
            retryPolicy: 'immediate_once',
            recoveryAction: 'reconnect',
            presentation: 'notice',
            recoverable: true,
        });
    });

    it('uses only the canonical retry vocabulary for every error kind', () => {
        const kinds = [
            'mic_permission_denied',
            'mic_permission_revoked',
            'mic_ended',
            'mic_plateau',
            'transport_disconnect',
            'provider_error',
            'provider_auth_invalid',
            'provider_setup_required',
            'execution_machine_unavailable',
            'reconnect_exhausted',
            'audio_context_suspended',
            'stt_timeout',
            'tts_failed',
            'turn_aborted',
            'authentication_required',
            'session_unavailable',
            'unsupported_runtime',
            'update_required',
            'feature_unavailable',
            'service_temporarily_unavailable',
            'mic_unavailable',
        ] as const;
        expect(kinds.map((kind) => createVoiceMachineError({ kind, reason: kind }).retryPolicy))
            .toEqual([
                'user_action',
                'user_action',
                'immediate_once',
                'immediate_once',
                'backoff',
                'user_action',
                'user_action',
                'user_action',
                'user_action',
                'user_action',
                'immediate_once',
                'user_action',
                'user_action',
                'never',
                'user_action',
                'never',
                'user_action',
                'user_action',
                'never',
                'user_action',
                'user_action',
            ]);
    });
});

describe('classifyRealtimeProviderFailure', () => {
    it.each([
        ['agent_signed_out', 'authentication_required', 'connect_agent'],
        ['credential_unavailable', 'provider_auth_invalid', 'review_credentials'],
        ['credential_access_review_required', 'provider_auth_invalid', 'review_credentials'],
        ['realtime_agent_update_required', 'provider_setup_required', 'open_settings'],
        ['update_required', 'update_required', 'update_agent_runtime'],
    ])('shares the canonical recovery for %s', (code, kind, recoveryAction) => {
        expect(classifyRealtimeProviderFailure(Object.assign(new Error('private provider detail'), { code })))
            .toMatchObject({ kind, recoveryAction });
        expect(resolveVoiceMachineErrorKind(code)).toBe(kind);
    });

    it('classifies permission errors as actionable preflight permission denial', () => {
        const error = Object.assign(new Error('permission_denied'), { name: 'NotAllowedError' });
        expect(classifyRealtimeProviderFailure(error)).toMatchObject({
            kind: 'mic_permission_denied',
            phase: 'preflight',
            retryPolicy: 'user_action',
            recoveryAction: 'open_settings',
            presentation: 'permission_required',
        });
    });

    it('falls back to a recoverable provider error otherwise', () => {
        expect(classifyRealtimeProviderFailure(new Error('socket reset'))).toMatchObject({
            kind: 'provider_error',
            reason: 'socket reset',
            recoverable: true,
        });
    });
});

describe('classifyVoiceMachineError', () => {
    it('maps a typed signed-out Agent refusal to authentication recovery', () => {
        expect(classifyVoiceMachineError({ code: 'agent_signed_out' }, {
            kind: 'provider_error', reason: 'agent_signed_out',
        })).toMatchObject({
            kind: 'authentication_required', reason: 'agent_signed_out',
            recoveryAction: 'connect_agent', presentation: 'error', recoverable: false,
        });
    });

    it('maps abort errors to turn_aborted', () => {
        const aborted = Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
        expect(classifyVoiceMachineError(aborted)).toMatchObject({ kind: 'turn_aborted' });
    });

    it('maps permission errors to mic_permission_denied', () => {
        expect(classifyVoiceMachineError({ name: 'NotAllowedError' })).toMatchObject({
            kind: 'mic_permission_denied',
            phase: 'preflight',
            retryPolicy: 'user_action',
        });
    });

    it('uses the provided fallback kind for unknown errors', () => {
        expect(classifyVoiceMachineError(new Error('boom'), { kind: 'stt_timeout' })).toMatchObject({
            kind: 'stt_timeout',
            reason: 'boom',
        });
    });

    it('defaults unknown errors to a provider error', () => {
        expect(classifyVoiceMachineError(undefined)).toMatchObject({ kind: 'provider_error' });
    });
});
