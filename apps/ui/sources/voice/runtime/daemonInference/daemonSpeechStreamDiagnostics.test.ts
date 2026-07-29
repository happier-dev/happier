import { describe, expect, it, vi } from 'vitest';

import { createDaemonSpeechStreamDiagnostics } from './daemonSpeechStreamDiagnostics';

describe('daemonSpeechStreamDiagnostics', () => {
    it('counts explicit transport selections and logs compatibility at most once per session', () => {
        const warn = vi.fn();
        const diagnostics = createDaemonSpeechStreamDiagnostics({ warn, maxRememberedSessions: 2 });

        diagnostics.record({ sessionId: 's1', machineId: 'm1', transport: 'json_rpc_compat' });
        diagnostics.record({ sessionId: 's1', machineId: 'm1', transport: 'json_rpc_compat' });
        diagnostics.record({ sessionId: 's2', machineId: 'm1', transport: 'binary_tunnel' });

        expect(diagnostics.snapshot()).toEqual({
            binaryTunnelSelections: 1,
            jsonRpcCompatibilitySelections: 2,
            jsonRpcCompatibilityForbidden: 0,
            lastTransport: 'binary_tunnel',
            lastBinaryTunnelReceipt: null,
            lastStartFailure: null,
        });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('retains only the bounded code and message for the latest pre-transport start failure', () => {
        const diagnostics = createDaemonSpeechStreamDiagnostics({ warn: () => undefined });

        diagnostics.recordStartFailure(Object.assign(new Error('voice_conversation_spawn_target_missing'), {
            code: 'VOICE_CONVERSATION_TARGET_MISSING',
            sensitiveContext: { token: 'must-not-be-retained' },
        }));

        expect(diagnostics.snapshot().lastStartFailure).toEqual({
            code: 'VOICE_CONVERSATION_TARGET_MISSING',
            message: 'voice_conversation_spawn_target_missing',
        });
        expect(JSON.stringify(diagnostics.snapshot())).not.toContain('must-not-be-retained');

        diagnostics.record({ sessionId: 's1', machineId: 'm1', transport: 'binary_tunnel' });
        expect(diagnostics.snapshot().lastStartFailure).toBeNull();
    });

    it('retains the stable stream transport unavailable failure without exposing arbitrary context', () => {
        const diagnostics = createDaemonSpeechStreamDiagnostics({ warn: () => undefined });

        diagnostics.recordStartFailure(Object.assign(
            new Error('daemon_voice_inference_stream_transport_unavailable'),
            {
                code: 'stream_transport_unavailable',
                sensitiveContext: { token: 'must-not-be-retained' },
            },
        ));

        expect(diagnostics.snapshot().lastStartFailure).toEqual({
            code: 'stream_transport_unavailable',
            message: 'daemon_voice_inference_stream_transport_unavailable',
        });
        expect(JSON.stringify(diagnostics.snapshot())).not.toContain('must-not-be-retained');

        const unsafeFailure = Object.assign(new Error('token=must-not-be-retained'), {
            code: 'stream_transport_unavailable',
        });
        unsafeFailure.stack = 'stack with token=must-not-be-retained';
        diagnostics.recordStartFailure(unsafeFailure);

        expect(diagnostics.snapshot().lastStartFailure).toEqual({
            code: 'stream_transport_unavailable',
            message: 'redacted_start_failure',
        });
        expect(JSON.stringify(diagnostics.snapshot())).not.toContain('must-not-be-retained');
    });

    it.each([
        'runtime_unavailable',
        'model_not_installed',
        'request_timeout',
        'invalid_audio_input',
        'unsupported_codec',
        'cancelled',
        'internal_error',
        'peer_route_signing_identity_unavailable',
        'MACHINE_RPC_ABORTED',
    ])('retains the canonical non-secret start failure code %s', (code) => {
        const diagnostics = createDaemonSpeechStreamDiagnostics({ warn: () => undefined });

        diagnostics.recordStartFailure(Object.assign(new Error('provider-private-message'), { code }));

        expect(diagnostics.snapshot().lastStartFailure).toEqual({
            code,
            message: 'redacted_start_failure',
        });
    });

    it('redacts arbitrary failure prose instead of retaining paths, URLs, or credentials', () => {
        const diagnostics = createDaemonSpeechStreamDiagnostics({ warn: () => undefined });

        diagnostics.recordStartFailure(Object.assign(
            new Error('Failed at /Users/alice/private.wav via https://user:secret@example.test'),
            { code: 'unsafe code: token=secret' },
        ));

        expect(diagnostics.snapshot().lastStartFailure).toEqual({
            code: null,
            message: 'redacted_start_failure',
        });
        expect(JSON.stringify(diagnostics.snapshot())).not.toContain('private.wav');
        expect(JSON.stringify(diagnostics.snapshot())).not.toContain('secret');
    });

    it('redacts credential-shaped single tokens that pass a generic token character class', () => {
        const diagnostics = createDaemonSpeechStreamDiagnostics({ warn: () => undefined });

        diagnostics.recordStartFailure(Object.assign(new Error('sk-proj-SECRET'), {
            code: 'token:secret',
        }));

        expect(diagnostics.snapshot().lastStartFailure).toEqual({
            code: null,
            message: 'redacted_start_failure',
        });
    });

    it('publishes a stable external-store snapshot when a transport selection changes', () => {
        const diagnostics = createDaemonSpeechStreamDiagnostics({ warn: () => undefined });
        const listener = vi.fn();
        const firstSnapshot = diagnostics.snapshot();
        const unsubscribe = diagnostics.subscribe(listener);

        expect(diagnostics.snapshot()).toBe(firstSnapshot);
        diagnostics.record({ sessionId: 's1', machineId: 'm1', transport: 'json_rpc_compat' });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(diagnostics.snapshot()).not.toBe(firstSnapshot);
        expect(diagnostics.snapshot().jsonRpcCompatibilitySelections).toBe(1);

        diagnostics.record({ sessionId: 's1', machineId: 'm1', transport: 'json_rpc_compat' });
        expect(listener).toHaveBeenCalledTimes(2);
        expect(diagnostics.snapshot().jsonRpcCompatibilitySelections).toBe(2);

        unsubscribe();
        diagnostics.record({ sessionId: 's2', machineId: 'm1', transport: 'binary_tunnel' });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('publishes authenticated relay evidence separately from local close and operation results', () => {
        const diagnostics = createDaemonSpeechStreamDiagnostics({ warn: () => undefined });
        const receipt = diagnostics.beginBinaryTunnelReceipt({
            routeKind: 'server_relay',
            frameEncoding: 'binary_frame_v2',
            carrierKind: 'binary_tunnel_frame_v2',
        });

        expect(diagnostics.snapshot().lastBinaryTunnelReceipt).toEqual({
            routeKind: 'server_relay',
            frameEncoding: 'binary_frame_v2',
            carrierKind: 'binary_tunnel_frame_v2',
            streamIdentity: null,
            relayEvidence: 'pending',
            maxAuthenticatedAckSeq: null,
            localTransport: 'open',
            operation: null,
        });

        receipt.recordStreamIdentity({
            machineId: 'machine-1',
            packId: 'stt-pack-1',
            streamId: 'stream-1',
            generation: 7,
        });
        receipt.recordRelayEvidence({ phase: 'install' });
        receipt.recordRelayEvidence({ phase: 'data', ackSeq: 4 });
        receipt.recordRelayEvidence({ phase: 'finish', ackSeq: 4 });

        expect(diagnostics.snapshot().lastBinaryTunnelReceipt).toMatchObject({
            streamIdentity: {
                machineId: 'machine-1',
                packId: 'stt-pack-1',
                streamId: 'stream-1',
                generation: 7,
            },
            relayEvidence: 'finish_authenticated',
            maxAuthenticatedAckSeq: 4,
            localTransport: 'open',
            operation: null,
        });

        receipt.recordOperationResult('finish', 'error');

        expect(diagnostics.snapshot().lastBinaryTunnelReceipt).toMatchObject({
            localTransport: 'open',
            operation: { kind: 'finish', result: 'error' },
        });

        receipt.recordLocalTransportClose('closed');

        expect(diagnostics.snapshot().lastBinaryTunnelReceipt).toMatchObject({
            localTransport: 'closed',
            operation: { kind: 'finish', result: 'error' },
        });

        diagnostics.record({ sessionId: 's1', machineId: 'm1', transport: 'json_rpc_compat' });
        receipt.recordRelayEvidence({ phase: 'data', ackSeq: 5 });

        expect(diagnostics.snapshot().lastBinaryTunnelReceipt).toBeNull();
    });
});
