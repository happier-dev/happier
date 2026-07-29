import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    classifyMicSessionFailure,
    classifyRealtimeProviderFailure,
    classifyVoiceMachineError,
    createVoiceMachineError,
    isVoiceMachineErrorKind,
} from './voiceMachineError';

describe('createVoiceMachineError', () => {
    it('mints complete structured policy for a preflight microphone denial', () => {
        expect(createVoiceMachineError({ kind: 'mic_permission_denied', reason: 'denied' })).toEqual({
            kind: 'mic_permission_denied',
            reason: 'denied',
            phase: 'preflight',
            retryPolicy: 'user_action',
            recoveryAction: 'open_settings',
            presentation: 'permission_required',
            recoverable: true,
        });
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

    it.each([
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
                'immediate_once',
                'user_action',
                'user_action',
                'never',
                'user_action',
                'never',
                'user_action',
                'user_action',
                'never',
            ]);
    });
});

describe('classifyRealtimeProviderFailure', () => {
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
