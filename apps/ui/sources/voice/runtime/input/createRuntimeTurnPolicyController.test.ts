import { describe, expect, it } from 'vitest';

import type { TurnEndpointSignal } from '@/voice/runtime/input/TurnEndpointController';
import { createTurnEndpointController } from './TurnEndpointController';

import {
    createRuntimeTurnPolicyController,
    type RuntimeTurnCaptureProvider,
    type RuntimeStoppedCaptureAction,
} from './createRuntimeTurnPolicyController';

function createEndpointSignal(
    overrides: Partial<TurnEndpointSignal> = {},
): TurnEndpointSignal {
    return {
        detectedAt: 1_000,
        sessionId: 'session-1',
        source: 'heuristic',
        transcript: 'hello runtime',
        endpoint: { reason: 'structural_fallback', confidence: null },
        ...overrides,
    };
}

describe('createRuntimeTurnPolicyController', () => {
    it('tracks hands-free capture sessions by provider with normalized session ids', () => {
        const controller = createRuntimeTurnPolicyController();

        controller.setHandsFreeCaptureSession({ provider: 'device', sessionId: ' session-1 ' });
        controller.setHandsFreeCaptureSession({ provider: 'local_neural', sessionId: 'session-2' });

        expect(controller.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' })).toBe(true);
        expect(controller.isHandsFreeCaptureSession({ provider: 'local_neural', sessionId: ' session-2 ' })).toBe(true);

        controller.clearHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' });
        expect(controller.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' })).toBe(false);
        expect(controller.isHandsFreeCaptureSession({ provider: 'local_neural', sessionId: 'session-2' })).toBe(true);
    });

    it('only escalates endpoint signals for active hands-free recording sessions', () => {
        const controller = createRuntimeTurnPolicyController();
        controller.setHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' });

        expect(controller.resolveEndpointSignalAction({
            currentStatus: 'recording',
            currentSessionId: 'session-1',
            handsFreeEnabled: true,
            inFlight: false,
            provider: 'device',
            signal: createEndpointSignal(),
        })).toEqual({
            kind: 'stop_capture',
            provider: 'device',
            sessionId: 'session-1',
        });

        expect(controller.resolveEndpointSignalAction({
            currentStatus: 'recording',
            currentSessionId: 'session-1',
            handsFreeEnabled: false,
            inFlight: false,
            provider: 'device',
            signal: createEndpointSignal(),
        })).toEqual({
            kind: 'ignore',
            reason: 'hands_free_disabled',
        });

        expect(controller.resolveEndpointSignalAction({
            currentStatus: 'recording',
            currentSessionId: 'session-1',
            handsFreeEnabled: true,
            inFlight: true,
            provider: 'device',
            signal: createEndpointSignal(),
        })).toEqual({
            kind: 'ignore',
            reason: 'in_flight',
        });
    });

    it.each(['ok', 'yes', 'stop please', 'yeah'])('submits the silent assistant reply %s without applying the interruption gate', (transcript) => {
        const controller = createRuntimeTurnPolicyController();
        const submissions: RuntimeStoppedCaptureAction[] = [];
        const endpoints = createTurnEndpointController({ onSignal: signal => {
            submissions.push(controller.resolveStoppedCaptureAction({
                adaptiveConfig: { ignoredPhrases: ['yeah'] },
                continueHandsFree: true,
                provider: 'local_neural',
                sessionId: 'session-1',
                transcript: signal.transcript,
                durationMs: signal.durationMs,
            }));
        } });
        endpoints.startSession('session-1');
        endpoints.signalEndpointDetected({ sessionId: 'session-1', source: 'daemon_stream', transcript: ` ${transcript} `, durationMs: 400 });
        endpoints.signalEndpointDetected({ sessionId: 'session-1', source: 'daemon_stream', transcript, durationMs: 400 });
        expect(submissions).toEqual([{
            kind: 'submit_turn',
            followUp: {
                kind: 'rearm_capture',
                provider: 'local_neural',
                sessionId: 'session-1',
            },
            transcript,
        }]);
    });

    it('submits substantive speech and rejects an empty capture while retaining hands-free rearming', () => {
        const controller = createRuntimeTurnPolicyController();
        expect(controller.resolveStoppedCaptureAction({
            adaptiveConfig: { ignoredPhrases: [] },
            continueHandsFree: true,
            provider: 'device',
            sessionId: 'session-2',
            transcript: '  ',
        })).toEqual({ kind: 'ignore', reason: 'empty_transcript', followUp: {
            kind: 'rearm_capture', provider: 'device', sessionId: 'session-2',
        } });
        expect(controller.resolveStoppedCaptureAction({
            adaptiveConfig: { ignoredPhrases: ['yeah'] },
            continueHandsFree: true,
            provider: 'device',
            sessionId: 'session-2',
            transcript: 'open the latest notes',
        })).toEqual({
            kind: 'submit_turn',
            followUp: {
                kind: 'rearm_capture',
                provider: 'device',
                sessionId: 'session-2',
            },
            transcript: 'open the latest notes',
        });
    });

    it('keeps manual barge-in decisions runtime-owned and session scoped', () => {
        const controller = createRuntimeTurnPolicyController();
        const speakingArgs = {
            bargeInEnabled: true,
            currentSessionId: 'session-1',
            currentStatus: 'speaking' as const,
            handsFree: true,
            provider: 'device' as RuntimeTurnCaptureProvider,
            requestedSessionId: 'session-1',
        };

        expect(controller.resolveManualBargeInAction(speakingArgs)).toEqual({
            kind: 'interrupt_and_rearm',
            handsFree: true,
            provider: 'device',
            sessionId: 'session-1',
        });

        expect(controller.resolveManualBargeInAction({
            ...speakingArgs,
            requestedSessionId: 'other-session',
        })).toEqual({
            kind: 'noop',
            reason: 'different_session',
        });

        expect(controller.resolveManualBargeInAction({
            ...speakingArgs,
            bargeInEnabled: false,
        })).toEqual({
            kind: 'noop',
            reason: 'barge_in_disabled',
        });
    });
});
