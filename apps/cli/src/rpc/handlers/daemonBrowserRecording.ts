import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    DaemonBrowserRecordingCancelRequestV1Schema,
    DaemonBrowserRecordingCancelResponseV1Schema,
    DaemonBrowserRecordingCleanupRequestV1Schema,
    DaemonBrowserRecordingCleanupResponseV1Schema,
    DaemonBrowserRecordingListRequestV1Schema,
    DaemonBrowserRecordingListResponseV1Schema,
    DaemonBrowserRecordingStartRequestV1Schema,
    DaemonBrowserRecordingStartResponseV1Schema,
    DaemonBrowserRecordingStatusRequestV1Schema,
    DaemonBrowserRecordingStatusResponseV1Schema,
    DaemonBrowserRecordingStopRequestV1Schema,
    DaemonBrowserRecordingStopResponseV1Schema,
    type DaemonBrowserRecordingCancelResponseV1,
    type DaemonBrowserRecordingCleanupResponseV1,
    type DaemonBrowserRecordingListResponseV1,
    type DaemonBrowserRecordingStartResponseV1,
    type DaemonBrowserRecordingStatusResponseV1,
    type DaemonBrowserRecordingStopResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';

export type DaemonBrowserRecordingHandlerOptions = Readonly<{
    browserRecording?: BrowserRecordingRoutes | null;
}>;

function requireBrowserRecordingRoutes(
    options: DaemonBrowserRecordingHandlerOptions,
): BrowserRecordingRoutes {
    if (!options.browserRecording) {
        throw new Error('Browser recording runtime is unavailable');
    }
    return options.browserRecording;
}

export function registerDaemonBrowserRecordingHandlers(
    rpc: RpcHandlerRegistrar,
    options: DaemonBrowserRecordingHandlerOptions = {},
): void {
    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_START,
        async (raw: unknown): Promise<DaemonBrowserRecordingStartResponseV1> => {
            const request = DaemonBrowserRecordingStartRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            return DaemonBrowserRecordingStartResponseV1Schema.parse({
                protocolVersion: 1,
                result: await browserRecording.startRecording(request.input),
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP,
        async (raw: unknown): Promise<DaemonBrowserRecordingStopResponseV1> => {
            const request = DaemonBrowserRecordingStopRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            return DaemonBrowserRecordingStopResponseV1Schema.parse({
                protocolVersion: 1,
                result: await browserRecording.stopRecording({
                    recordingId: request.recordingId,
                    stoppedAtMs: request.stoppedAtMs,
                    navigationGenerationEnd: request.navigationGenerationEnd,
                    expiresAtMs: request.expiresAtMs,
                }),
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL,
        async (raw: unknown): Promise<DaemonBrowserRecordingCancelResponseV1> => {
            const request = DaemonBrowserRecordingCancelRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            return DaemonBrowserRecordingCancelResponseV1Schema.parse({
                protocolVersion: 1,
                result: await browserRecording.cancelRecording({
                    recordingId: request.recordingId,
                    atMs: request.atMs,
                    reason: request.reason,
                }),
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
        async (raw: unknown): Promise<DaemonBrowserRecordingStatusResponseV1> => {
            const request = DaemonBrowserRecordingStatusRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            return DaemonBrowserRecordingStatusResponseV1Schema.parse({
                protocolVersion: 1,
                recording: await browserRecording.getRecordingStatus({
                    recordingId: request.recordingId,
                }),
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
        async (raw: unknown): Promise<DaemonBrowserRecordingListResponseV1> => {
            const request = DaemonBrowserRecordingListRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            return DaemonBrowserRecordingListResponseV1Schema.parse({
                protocolVersion: 1,
                recordings: await browserRecording.listRecordingsForView({
                    viewId: request.viewId,
                }),
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP,
        async (raw: unknown): Promise<DaemonBrowserRecordingCleanupResponseV1> => {
            const request = DaemonBrowserRecordingCleanupRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            return DaemonBrowserRecordingCleanupResponseV1Schema.parse({
                protocolVersion: 1,
                result: await browserRecording.cleanupExpiredRecordings({
                    nowMs: request.nowMs,
                }),
            });
        },
    );
}
