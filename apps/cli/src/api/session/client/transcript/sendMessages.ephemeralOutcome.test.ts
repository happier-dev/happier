import { describe, expect, it, vi } from 'vitest';

import type { SessionClientTranscriptSendPort } from './sendMessages';
import {
    sendAgentMessageEphemeralDeltaViaPort,
    sendAgentMessageEphemeralViaPort,
} from './sendMessages';

function createPort(overrides: Partial<SessionClientTranscriptSendPort> = {}): SessionClientTranscriptSendPort {
    return {
        sessionId: 'session-1',
        socket: {
            connected: true,
            emit: vi.fn(),
        },
        getEphemeralStreamConnectionEpoch: () => 7,
        outboundShapeLogger: { log: vi.fn() },
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        getMetadataSnapshot: () => null,
        buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
        commitSessionMessageBestEffort: vi.fn(async () => undefined),
        logSendWhileDisconnected: vi.fn(),
        markAgentQueueEchoSuppressedLocalId: vi.fn(),
        toolCallCanonicalNameByProviderAndId: new Map(),
        permissionToolCallRawInputByProviderAndId: new Map(),
        toolCallInputByProviderAndId: new Map(),
        ...overrides,
    };
}

describe('ephemeral transcript local acceptance', () => {
    it('reports disconnected snapshot and delta sends without attempting transport work', () => {
        const emit = vi.fn();
        const port = createPort({
            socket: { connected: false, emit },
            getEphemeralStreamConnectionEpoch: () => 11,
        });

        const snapshot = sendAgentMessageEphemeralViaPort(
            port,
            'codex',
            { type: 'message', message: 'hello' },
            { localId: 'segment-1', createdAt: 1 },
        );
        const delta = sendAgentMessageEphemeralDeltaViaPort(
            port,
            'codex',
            { type: 'message', message: ' world' },
            { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 1 },
        );

        expect(snapshot).toEqual({ accepted: false, epoch: 11, reason: 'disconnected' });
        expect(delta).toEqual({ accepted: false, epoch: 11, reason: 'disconnected' });
        expect(emit).not.toHaveBeenCalled();
    });

    it('reports bounded serialization and emit failures at their local stage', () => {
        const serializeFailure = sendAgentMessageEphemeralViaPort(
            createPort({
                buildOutboundSessionMessagePayload: () => {
                    throw new Error(`serialize ${'x'.repeat(20_000)}`);
                },
            }),
            'codex',
            { type: 'message', message: 'hello' },
            { localId: 'segment-1', createdAt: 1 },
        );
        const emitFailure = sendAgentMessageEphemeralDeltaViaPort(
            createPort({
                socket: {
                    connected: true,
                    emit: () => {
                        throw new Error('emit failed https://alice:SUPER_SECRET@api.example.test/live?token=secret');
                    },
                },
            }),
            'codex',
            { type: 'message', message: ' world' },
            { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 1 },
        );

        expect(serializeFailure).toMatchObject({
            accepted: false,
            epoch: 7,
            reason: 'serialize_failed',
            error: { name: 'Error' },
        });
        expect(JSON.stringify(serializeFailure).length).toBeLessThan(10_000);
        expect(emitFailure).toMatchObject({
            accepted: false,
            epoch: 7,
            reason: 'emit_failed',
            error: { message: 'emit failed https://api.example.test/live' },
        });
        expect(JSON.stringify(emitFailure)).not.toContain('SUPER_SECRET');
        expect(JSON.stringify(emitFailure)).not.toContain('token=secret');
    });

    it('does not emit a snapshot when assistant observation fails', () => {
        const emit = vi.fn();
        const outcome = sendAgentMessageEphemeralViaPort(
            createPort({
                socket: { connected: true, emit },
                turnAssistantTextSnapshotStore: {
                    observe: () => {
                        throw new Error('observation failed');
                    },
                } as never,
            }),
            'codex',
            { type: 'message', message: 'hello' },
            { localId: 'segment-1', createdAt: 1 },
        );

        expect(outcome).toMatchObject({
            accepted: false,
            epoch: 7,
            reason: 'observe_failed',
            error: { message: 'observation failed' },
        });
        expect(emit).not.toHaveBeenCalled();
    });

    it('returns the current epoch only after the complete snapshot and delta paths succeed', () => {
        const port = createPort();

        expect(sendAgentMessageEphemeralViaPort(
            port,
            'codex',
            { type: 'message', message: 'hello' },
            { localId: 'segment-1', createdAt: 1 },
        )).toEqual({ accepted: true, epoch: 7 });
        expect(sendAgentMessageEphemeralDeltaViaPort(
            port,
            'codex',
            { type: 'message', message: ' world' },
            { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 1 },
        )).toEqual({ accepted: true, epoch: 7 });
    });
});
