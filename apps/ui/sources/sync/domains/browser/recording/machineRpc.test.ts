import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
        machineRpcWithServerScopeMock(...args),
}));

function recording(overrides: Partial<BrowserRecordingSessionV1> = {}): BrowserRecordingSessionV1 {
    return {
        v: 1,
        recordingId: 'recording_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        profileId: 'profile_1',
        targetKind: 'simulatorPreview',
        adapterKind: 'simulatorPreview',
        renderEngineKind: 'streamedSurface',
        captureKind: 'streamFrameCapture',
        fidelity: 'streamFrame',
        startedAtMs: 10_000,
        status: 'recording',
        navigationGenerationStart: 4,
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
        ...overrides,
    };
}

describe('browser recording daemon machine RPC client', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('starts recording through the typed daemon RPC method', async () => {
        const started = recording();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            protocolVersion: 1,
            result: { status: 'started', recording: started },
        });
        const { startBrowserRecordingViaMachineRpc } = await import('./machineRpc');

        await expect(startBrowserRecordingViaMachineRpc({
            machineId: 'machine_1',
            serverId: 'server_1',
            input: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                profileId: 'profile_1',
                targetKind: 'simulatorPreview',
                adapterKind: 'simulatorPreview',
                renderEngineKind: 'streamedSurface',
                captureKind: 'streamFrameCapture',
                fidelity: 'streamFrame',
                navigationGeneration: 4,
                mimeType: 'video/webm',
                retentionClass: 'preSend',
                policyState: 'allowed',
                mediaTarget: { sessionId: 'session_1', messageLocalId: 'browser-recording-view_1-10000' },
                captureSource: { kind: 'machineLiveStream', streamFamily: 'source_1', sourceId: 'source_1' },
                startedAtMs: 10_000,
                recordingId: 'recording_1',
            },
        })).resolves.toEqual({
            ok: true,
            result: { status: 'started', recording: started },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            method: RPC_METHODS.DAEMON_BROWSER_RECORDING_START,
            payload: {
                protocolVersion: 1,
                machineId: 'machine_1',
                input: expect.objectContaining({
                    browserSessionId: 'browser_session_1',
                    mediaTarget: { sessionId: 'session_1', messageLocalId: 'browser-recording-view_1-10000' },
                    captureSource: { kind: 'machineLiveStream', streamFamily: 'source_1', sourceId: 'source_1' },
                }),
            },
        });
    });

    it('stops, cancels, reads status, lists, and cleans up through typed daemon methods', async () => {
        const finalized = recording({
            status: 'finalized',
            outcomeReason: 'user_stopped',
            stoppedAtMs: 12_000,
            navigationGenerationEnd: 5,
            durationMs: 2_000,
            byteSize: 500_000,
            frameCount: 24,
            mediaRef: {
                refKind: 'sessionMedia',
                mediaId: 'media_1',
                mediaKind: 'video',
                mimeType: 'video/webm',
                sizeBytes: 500_000,
            },
        });
        const canceled = recording({
            recordingId: 'recording_2',
            status: 'canceled',
            outcomeReason: 'user_canceled',
            stoppedAtMs: 11_000,
            durationMs: 1_000,
        });
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ protocolVersion: 1, result: { status: 'finalized', recording: finalized } })
            .mockResolvedValueOnce({ protocolVersion: 1, result: { status: 'canceled', recording: canceled } })
            .mockResolvedValueOnce({ protocolVersion: 1, recording: finalized })
            .mockResolvedValueOnce({ protocolVersion: 1, recordings: [finalized] })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                result: { discardedRecordingIds: ['recording_3'], failedRecordingIds: [] },
            });
        const mod = await import('./machineRpc');

        await expect(mod.stopBrowserRecordingViaMachineRpc({
            machineId: 'machine_1',
            recordingId: 'recording_1',
            navigationGenerationEnd: 5,
            stoppedAtMs: 12_000,
            expiresAtMs: 20_000,
        })).resolves.toEqual({ ok: true, result: { status: 'finalized', recording: finalized } });
        await expect(mod.cancelBrowserRecordingViaMachineRpc({
            machineId: 'machine_1',
            recordingId: 'recording_2',
            atMs: 11_000,
            reason: 'user_canceled',
        })).resolves.toEqual({ ok: true, result: { status: 'canceled', recording: canceled } });
        await expect(mod.fetchBrowserRecordingStatusViaMachineRpc({
            machineId: 'machine_1',
            recordingId: 'recording_1',
        })).resolves.toEqual({ ok: true, recording: finalized });
        await expect(mod.listBrowserRecordingsForViewViaMachineRpc({
            machineId: 'machine_1',
            viewId: 'view_1',
        })).resolves.toEqual({ ok: true, recordings: [finalized] });
        await expect(mod.cleanupBrowserRecordingsViaMachineRpc({
            machineId: 'machine_1',
            nowMs: 30_000,
        })).resolves.toEqual({
            ok: true,
            result: { discardedRecordingIds: ['recording_3'], failedRecordingIds: [] },
        });

        expect(machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method: string }).method)).toEqual([
            RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
            RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP,
        ]);
    });

    it('fails closed for method-not-found, thrown transport errors, invalid responses, and machine id mismatches', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'missing' })
            .mockRejectedValueOnce(new Error('socket closed'))
            .mockResolvedValueOnce({ protocolVersion: 1, result: { status: 'started' } })
            .mockResolvedValueOnce({
                protocolVersion: 1,
                result: { status: 'started', recording: recording({ browserSessionId: 'wrong_session' }) },
            });
        const { startBrowserRecordingViaMachineRpc } = await import('./machineRpc');
        const input = {
            machineId: 'machine_1',
            input: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                profileId: 'profile_1',
                targetKind: 'simulatorPreview',
                adapterKind: 'simulatorPreview',
                renderEngineKind: 'streamedSurface',
                captureKind: 'streamFrameCapture',
                fidelity: 'streamFrame',
                navigationGeneration: 4,
                mimeType: 'video/webm',
                retentionClass: 'preSend',
                mediaTarget: { sessionId: 'session_1', messageLocalId: 'browser-recording-view_1-10000' },
                captureSource: { kind: 'machineLiveStream', streamFamily: 'source_1', sourceId: 'source_1' },
            },
        } as const;

        await expect(startBrowserRecordingViaMachineRpc(input)).resolves.toEqual({
            ok: false,
            reason: 'unavailable',
        });
        await expect(startBrowserRecordingViaMachineRpc(input)).resolves.toEqual({
            ok: false,
            reason: 'request_failed',
        });
        await expect(startBrowserRecordingViaMachineRpc(input)).resolves.toEqual({
            ok: false,
            reason: 'invalid_response',
        });
        await expect(startBrowserRecordingViaMachineRpc(input)).resolves.toEqual({
            ok: false,
            reason: 'invalid_response',
        });
    });
});
