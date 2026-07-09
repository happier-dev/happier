import { describe, expect, it } from 'vitest';

import {
    classifyMicSessionFailure,
    classifyRealtimeProviderFailure,
    classifyVoiceMachineError,
    createVoiceMachineError,
    isVoiceMachineErrorKind,
} from './voiceMachineError';

describe('createVoiceMachineError', () => {
    it('resolves recoverability from the per-kind table when omitted', () => {
        expect(createVoiceMachineError({ kind: 'provider_error', reason: 'x' })).toEqual({
            kind: 'provider_error',
            reason: 'x',
            recoverable: true,
        });
        expect(createVoiceMachineError({ kind: 'mic_permission_denied', reason: 'denied' })).toEqual({
            kind: 'mic_permission_denied',
            reason: 'denied',
            recoverable: false,
        });
    });

    it('respects an explicit recoverable override', () => {
        expect(
            createVoiceMachineError({ kind: 'mic_permission_denied', reason: 'denied', recoverable: true }),
        ).toMatchObject({ recoverable: true });
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
            recoverable: true,
        });
    });
});

describe('classifyRealtimeProviderFailure', () => {
    it('classifies permission errors as non-recoverable permission denial', () => {
        const error = Object.assign(new Error('permission_denied'), { name: 'NotAllowedError' });
        expect(classifyRealtimeProviderFailure(error)).toMatchObject({
            kind: 'mic_permission_denied',
            recoverable: false,
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
            recoverable: false,
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
