import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AgentSessionRuntime } from '../../agentRuntime/session.js';
import {
    assertExperimentalAgentSessionRealtimeRuntime,
    type AgentSessionRealtimeAvailability,
    type AgentSessionRealtimeConversation,
    type AgentSessionRealtimeHandle,
    type AgentSessionRealtimeLifecycleEvent,
    type AgentSessionRealtimeStartInput,
    type AgentSessionRealtimeStartResult,
    type AgentSessionRealtimeStopResult,
    type ExperimentalAgentSessionRealtimeRuntime,
} from './realtime.js';

describe('experimental Agent session realtime contract', () => {
    it('validates the complete declaration-gated extension without changing AgentSessionRuntime', () => {
        const handle: AgentSessionRealtimeHandle = {
            stop: vi.fn(async () => ({ status: 'stopped' as const })),
            dispose: vi.fn(async () => {}),
            watch: vi.fn(() => ({ dispose() {} })),
        };
        const runtime: AgentSessionRuntime = {
            send: vi.fn(async () => ({ status: 'admitted' as const })),
            watch: vi.fn(() => ({ dispose() {} })),
            dispose: vi.fn(async () => {}),
        };
        const candidate = Object.assign(runtime, {
            realtimeConversation: {
                inspect: vi.fn(async (): Promise<AgentSessionRealtimeAvailability> => ({
                    status: 'available',
                    transport: 'webrtc',
                })),
                start: vi.fn(async () => ({
                    status: 'started' as const,
                    transport: { kind: 'webrtc' as const, answerSdp: 'answer-sdp' },
                    handle,
                })),
            },
        });

        const validated = assertExperimentalAgentSessionRealtimeRuntime(candidate);

        expect(validated).toBe(candidate);
        expectTypeOf(validated).toEqualTypeOf<ExperimentalAgentSessionRealtimeRuntime>();
        expectTypeOf<AgentSessionRuntime>().not.toHaveProperty('realtimeConversation');
    });

    it.each([
        null,
        {},
        { realtimeConversation: {} },
        { realtimeConversation: { inspect() {} } },
        { realtimeConversation: { start() {} } },
    ])('rejects malformed extension value %#', (candidate) => {
        expect(() => assertExperimentalAgentSessionRealtimeRuntime(candidate)).toThrow(
            'Malformed experimental Agent session realtime runtime',
        );
    });

    it('publishes the exact immutable WebRTC-only DTO family', () => {
        const event: AgentSessionRealtimeLifecycleEvent = {
            kind: 'terminal',
            reason: 'error',
            diagnostic: { code: 'upstream_rejected', severity: 'error' },
        };

        expect(event).toEqual({
            kind: 'terminal',
            reason: 'error',
            diagnostic: { code: 'upstream_rejected', severity: 'error' },
        });
        expectTypeOf<AgentSessionRealtimeAvailability>().toEqualTypeOf<
            | Readonly<{ status: 'available'; transport: 'webrtc' }>
            | Readonly<{
                status: 'unavailable';
                reason: 'authentication_required' | 'session_unavailable' | 'unsupported_runtime' | 'update_required' | 'feature_unavailable';
                diagnostic: import('../../diagnostics.js').PluginDiagnosticData;
            }>
        >();
        expectTypeOf<AgentSessionRealtimeStartInput>().toEqualTypeOf<
            Readonly<{ transport: Readonly<{ kind: 'webrtc'; offerSdp: string }> }>
        >();
        expectTypeOf<AgentSessionRealtimeStartResult>().toEqualTypeOf<
            | Readonly<{
                status: 'started';
                transport: Readonly<{ kind: 'webrtc'; answerSdp: string }>;
                handle: AgentSessionRealtimeHandle;
            }>
            | Readonly<{ status: 'busy' | 'aborted' }>
            | Readonly<{
                status: 'unavailable' | 'failed';
                diagnostic: import('../../diagnostics.js').PluginDiagnosticData;
            }>
        >();
        expectTypeOf<AgentSessionRealtimeStopResult>().toEqualTypeOf<
            | Readonly<{ status: 'stopped' | 'already_stopped' | 'aborted' }>
            | Readonly<{
                status: 'unavailable';
                diagnostic: import('../../diagnostics.js').PluginDiagnosticData;
            }>
        >();
        expectTypeOf<keyof AgentSessionRealtimeHandle>().toEqualTypeOf<
            'stop' | 'watch' | 'dispose'
        >();
        expectTypeOf(event).not.toHaveProperty('raw');
        expectTypeOf(event).not.toHaveProperty('threadId');
        expectTypeOf(event).not.toHaveProperty('audio');
        expectTypeOf(event).not.toHaveProperty('transcript');
        expectTypeOf(event).not.toHaveProperty('activity');
        expectTypeOf(event).not.toHaveProperty('cancelResponse');
    });

    it('owns one exact Agent realtime conversation contract', () => {
        expectTypeOf<keyof AgentSessionRealtimeConversation>().toEqualTypeOf<
            'inspect' | 'start'
        >();
        expectTypeOf<ExperimentalAgentSessionRealtimeRuntime['realtimeConversation']>()
            .toEqualTypeOf<AgentSessionRealtimeConversation>();
    });
});
