import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonBrowserRecordingCancelRequestV1Schema, DaemonBrowserRecordingCancelResponseV1Schema, DaemonBrowserRecordingCleanupRequestV1Schema, DaemonBrowserRecordingCleanupResponseV1Schema, DaemonBrowserRecordingListRequestV1Schema, DaemonBrowserRecordingListResponseV1Schema, DaemonBrowserRecordingStartRequestV1Schema, DaemonBrowserRecordingStartResponseV1Schema, DaemonBrowserRecordingStatusRequestV1Schema, DaemonBrowserRecordingStatusResponseV1Schema, DaemonBrowserRecordingStopRequestV1Schema, DaemonBrowserRecordingStopResponseV1Schema } from '@happier-dev/protocol/browser/recording/v1';
import type { DaemonBrowserRecordingCancelResponseV1, DaemonBrowserRecordingCleanupResponseV1, DaemonBrowserRecordingListResponseV1, DaemonBrowserRecordingStartResponseV1, DaemonBrowserRecordingStatusResponseV1, DaemonBrowserRecordingStopResponseV1 } from '@happier-dev/protocol/browser/recording/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { createBrowserRawRequestAdmission } from './daemonBrowserRequestAdmission';

export type DaemonBrowserRecordingHandlerOptions = Readonly<{
    browserRecording?: BrowserRecordingRoutes | null;
    resolveBrowserControl?: () => BrowserDaemonControlRoutes | null | undefined;
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
        async (raw: unknown, context): Promise<DaemonBrowserRecordingStartResponseV1> => {
            const request = DaemonBrowserRecordingStartRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            const admission = createBrowserRawRequestAdmission(options.resolveBrowserControl, context);
            admission.requireTarget({ browserSessionId: request.input.browserSessionId });
            const runtimeAccountId = context?.machineAdmission?.actorAccountId
                ?? (context?.authorization?.kind === 'session.browser' ? context.authorization.actorAccountId : undefined);
            return DaemonBrowserRecordingStartResponseV1Schema.parse({
                protocolVersion: 1,
                result: await browserRecording.startRecording(request.input, { runtimeAccountId }),
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP,
        async (raw: unknown, context): Promise<DaemonBrowserRecordingStopResponseV1> => {
            const request = DaemonBrowserRecordingStopRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            const admission = createBrowserRawRequestAdmission(options.resolveBrowserControl, context);
            await admission.requireRecording(browserRecording, request.recordingId);
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
        async (raw: unknown, context): Promise<DaemonBrowserRecordingCancelResponseV1> => {
            const request = DaemonBrowserRecordingCancelRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            const admission = createBrowserRawRequestAdmission(options.resolveBrowserControl, context);
            await admission.requireRecording(browserRecording, request.recordingId);
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
        async (raw: unknown, context): Promise<DaemonBrowserRecordingStatusResponseV1> => {
            const request = DaemonBrowserRecordingStatusRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            const admission = createBrowserRawRequestAdmission(options.resolveBrowserControl, context);
            const recording = await admission.requireRecording(browserRecording, request.recordingId);
            return DaemonBrowserRecordingStatusResponseV1Schema.parse({
                protocolVersion: 1,
                recording,
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
        async (raw: unknown, context): Promise<DaemonBrowserRecordingListResponseV1> => {
            const request = DaemonBrowserRecordingListRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            const admission = createBrowserRawRequestAdmission(options.resolveBrowserControl, context);
            admission.requireTarget(request);
            return DaemonBrowserRecordingListResponseV1Schema.parse({
                protocolVersion: 1,
                recordings: (await browserRecording.listRecordingsForView({
                    browserSessionId: request.browserSessionId,
                    viewId: request.viewId,
                })).filter(admission.allowsRecording),
            });
        },
    );

    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP,
        async (raw: unknown, context): Promise<DaemonBrowserRecordingCleanupResponseV1> => {
            const request = DaemonBrowserRecordingCleanupRequestV1Schema.parse(raw);
            const browserRecording = requireBrowserRecordingRoutes(options);
            const admission = createBrowserRawRequestAdmission(options.resolveBrowserControl, context);
            return DaemonBrowserRecordingCleanupResponseV1Schema.parse({
                protocolVersion: 1,
                result: await browserRecording.cleanupExpiredRecordings({
                    nowMs: request.nowMs,
                }, { includeRecording: admission.allowsRecording }),
            });
        },
    );
}
