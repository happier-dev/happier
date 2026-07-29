import { describe, expect, it, vi } from 'vitest';

import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
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

describe('registerSessionHandlers browser recording integration', () => {
    it('registers BRW-15 browser recording RPC handlers with the supplied daemon routes', async () => {
        const { registerSessionHandlers } = await import('./registerSessionHandlers');
        const { handlers, registrar } = createRegistrar();
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
            getRecordingStatus: vi.fn(async () => null),
            listRecordingsForView: vi.fn(async () => []),
            cleanupExpiredRecordings: vi.fn(async () => ({ discardedRecordingIds: [], failedRecordingIds: [] })),
        };

        registerSessionHandlers(registrar, process.cwd(), { browserRecording });

        await expect(handlers.get(RPC_METHODS.DAEMON_BROWSER_RECORDING_START)?.({
            protocolVersion: 1,
            machineId: 'machine_1',
            input: {
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
            },
        })).resolves.toMatchObject({
            protocolVersion: 1,
            result: { status: 'started', recording: { recordingId: 'recording_1' } },
        });
    });
});
