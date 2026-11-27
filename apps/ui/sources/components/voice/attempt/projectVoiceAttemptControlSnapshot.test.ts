import { describe, expect, it } from 'vitest';

import type { VoiceSessionSnapshot } from '@/voice/session/types';

import { projectVoiceAttemptControlSnapshot } from './projectVoiceAttemptControlSnapshot';

const idle: VoiceSessionSnapshot = {
    adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
};

describe('projectVoiceAttemptControlSnapshot', () => {
    it('keeps capture and setup presentation context explicit for UI and Action readers', () => {
        const connected: VoiceSessionSnapshot = {
            ...idle, adapterId: 'provider', sessionId: 'conversation', status: 'connected',
            mode: 'listening', canStop: true, canCommitInput: true, inputEndsOnSilence: true,
        };
        const input = { snapshot: connected, startAdmitted: false, hasRecovery: false, setupOffered: false };
        expect(projectVoiceAttemptControlSnapshot({ ...input, capturing: true })).toMatchObject({
            surfaceState: 'listening', canMute: true, canCommitInput: true,
            capturing: true, muted: false, awaitingSend: false,
        });
        expect(projectVoiceAttemptControlSnapshot({ ...input, capturing: false })).toMatchObject({
            capturing: false, canMute: true, primaryAction: 'end',
        });
        const resting = { ...input, snapshot: idle, capturing: false };
        expect(projectVoiceAttemptControlSnapshot({ ...resting, setupOffered: true })).toMatchObject({
            availability: 'setup', primaryAction: 'setup',
        });
        expect(projectVoiceAttemptControlSnapshot({ ...resting, setupOffered: false })).toMatchObject({
            availability: 'unavailable', primaryAction: null,
        });
    });

    it('preserves terminal failure acknowledgement and ending input retirement from lifecycle facts', () => {
        const input = { snapshot: {
            ...idle, adapterId: 'provider', errorPresentation: 'error' as const, errorCode: 'failed',
        }, startAdmitted: false, hasRecovery: false, capturing: false, setupOffered: true };
        expect(projectVoiceAttemptControlSnapshot(input)).toMatchObject({
            live: true, surfaceState: 'error', availability: 'recoverable',
            canDismissFailedAttempt: true, primaryAction: null,
        });
        expect(projectVoiceAttemptControlSnapshot({ ...input, snapshot: {
            ...idle, adapterId: 'provider', sessionId: 'conversation', status: 'connected',
            mode: 'listening', presentationState: 'ending', canStop: true, canCommitInput: true,
        } })).toMatchObject({
            surfaceState: 'ending', primaryAction: 'end', canCommitInput: false, canMute: false,
        });
    });
});
