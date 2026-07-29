import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

function createRegistrar(): { handlers: Map<string, (payload: unknown) => Promise<unknown>>; registrar: RpcHandlerRegistrar } {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method, handler) {
                handlers.set(method, handler as (payload: unknown) => Promise<unknown>);
            },
        },
    };
}

const recording = {
    v: 1,
    recordingId: 'recording_1',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'localServicePreview',
    adapterKind: 'localPreview',
    renderEngineKind: 'webIframe',
    captureKind: 'streamFrameCapture',
    fidelity: 'streamFrame',
    startedAtMs: 10_000,
    status: 'recording',
    navigationGenerationStart: 7,
    durationMs: 0,
    byteSize: 0,
    frameCount: 0,
    fps: 12,
    mimeType: 'video/webm',
    retentionClass: 'preSend',
    redactionLevel: 'metadataOnly',
    policyState: 'allowed',
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    actionChapters: [],
    relatedReferences: [],
} satisfies BrowserRecordingSessionV1;

const normalizedRecording = {
    ...recording,
    actionChapters: [],
    relatedReferences: [],
};

const startInput = {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'localServicePreview',
    adapterKind: 'localPreview',
    renderEngineKind: 'webIframe',
    captureKind: 'streamFrameCapture',
    fidelity: 'streamFrame',
    navigationGeneration: 7,
    mimeType: 'video/webm',
    retentionClass: 'preSend',
} as const;

describe('daemon browser recording rpc handlers', () => {
    it('registers BRW-15 recording commands and routes protocol requests to daemon recording routes', async () => {
        const module = await import('./daemonBrowserRecording').catch(() => null);

        expect(module?.registerDaemonBrowserRecordingHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonBrowserRecordingHandlers) return;

        const browserRecording = {
            startRecording: vi.fn(async () => ({ status: 'started' as const, recording })),
            stopRecording: vi.fn(async () => ({
                status: 'unavailable' as const,
                reason: { code: 'browser_recording_missing', message: 'Browser recording is no longer available.' },
            })),
            cancelRecording: vi.fn(async () => ({
                status: 'unavailable' as const,
                reason: { code: 'browser_recording_missing', message: 'Browser recording is no longer available.' },
            })),
            getRecordingStatus: vi.fn(async () => recording),
            listRecordingsForView: vi.fn(async () => [recording]),
            cleanupExpiredRecordings: vi.fn(async () => ({
                discardedRecordingIds: ['recording_expired'],
                failedRecordingIds: [],
            })),
        };
        const { handlers, registrar } = createRegistrar();

        module.registerDaemonBrowserRecordingHandlers(registrar, { browserRecording });

        expect([...handlers.keys()].sort()).toEqual([
            RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_START,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP,
        ].sort());
        await expect(handlers.get(RPC_METHODS.DAEMON_BROWSER_RECORDING_START)?.({
            protocolVersion: 1,
            machineId: 'machine_1',
            input: startInput,
        })).resolves.toEqual({
            protocolVersion: 1,
            result: { status: 'started', recording: normalizedRecording },
        });
        expect(browserRecording.startRecording).toHaveBeenCalledWith(startInput);

        await expect(handlers.get(RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS)?.({
            protocolVersion: 1,
            machineId: 'machine_1',
            recordingId: 'recording_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            recording: normalizedRecording,
        });
        expect(browserRecording.getRecordingStatus).toHaveBeenCalledWith({ recordingId: 'recording_1' });

        await expect(handlers.get(RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST)?.({
            protocolVersion: 1,
            machineId: 'machine_1',
            viewId: 'view_1',
        })).resolves.toEqual({
            protocolVersion: 1,
            recordings: [normalizedRecording],
        });
        expect(browserRecording.listRecordingsForView).toHaveBeenCalledWith({ viewId: 'view_1' });

        await expect(handlers.get(RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP)?.({
            protocolVersion: 1,
            machineId: 'machine_1',
            nowMs: 13_001,
        })).resolves.toEqual({
            protocolVersion: 1,
            result: {
                discardedRecordingIds: ['recording_expired'],
                failedRecordingIds: [],
            },
        });
        expect(browserRecording.cleanupExpiredRecordings).toHaveBeenCalledWith({ nowMs: 13_001 });
    });

    it('fails closed when daemon recording routes are unavailable', async () => {
        const module = await import('./daemonBrowserRecording').catch(() => null);

        expect(module?.registerDaemonBrowserRecordingHandlers).toBeTypeOf('function');
        if (!module?.registerDaemonBrowserRecordingHandlers) return;

        const { handlers, registrar } = createRegistrar();
        module.registerDaemonBrowserRecordingHandlers(registrar);

        await expect(handlers.get(RPC_METHODS.DAEMON_BROWSER_RECORDING_START)?.({
            protocolVersion: 1,
            machineId: 'machine_1',
            input: startInput,
        })).rejects.toThrow('Browser recording runtime is unavailable');
    });
});
