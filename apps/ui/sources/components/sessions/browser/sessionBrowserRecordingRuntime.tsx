import type {
    BrowserCapabilities,
    BrowserRecordingCaptureSourceV1,
    BrowserRecordingCapabilities,
    DaemonBrowserRecordingUnavailableReasonV1,
    BrowserRecordingSessionV1,
} from '@happier-dev/protocol';
import {
    DEFAULT_BROWSER_CAPABILITIES,
    simulatorCaptureStreamFamilyV1,
} from '@happier-dev/protocol';
import * as React from 'react';

import type { BrowserShellRecordingState } from '@/components/browser/BrowserShell';
import type { BrowserRecordingStartControlRequest } from '@/components/browser/recording';
import {
    applyBrowserRecordingSessionSnapshot,
    createBrowserRecordingState,
    startBrowserRecordingSession,
    type BrowserRecordingState,
    type BrowserRecordingUnavailableReason,
} from '@/sync/domains/browser/recording';
import {
    isBrowserRecordingCaptureSourceAvailable,
    useDesktopBrowserRecordingReverseCaptureHandler,
} from '@/sync/domains/browser/recording/reverseCaptureAvailability';
import {
    cancelBrowserRecordingViaMachineRpc,
    startBrowserRecordingViaMachineRpc,
    stopBrowserRecordingViaMachineRpc,
} from '@/sync/domains/browser/recording/machineRpc';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';

const DEFAULT_RECORDING_CAPABILITIES = DEFAULT_BROWSER_CAPABILITIES.recording;

export type SessionBrowserRecordingRuntime = Readonly<{
    state: BrowserRecordingState;
    browserShellRecording: BrowserShellRecordingState;
}>;

export type SessionBrowserRecordingRuntimeInput = Readonly<{
    enabled: boolean;
    scopeKey?: string | null;
    sessionId: string;
    machineId?: string | null;
    serverId?: string | null;
    recordingCapabilities?: BrowserRecordingCapabilities;
    nowMs?: () => number;
    onUnavailable?: BrowserShellRecordingState['onUnavailable'];
}>;

function sanitizeMessageLocalIdSegment(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return sanitized.length > 0 ? sanitized.slice(0, 80) : 'view';
}

function buildRecordingMessageLocalId(viewId: string, atMs: number): string {
    return `browser-recording-${sanitizeMessageLocalIdSegment(viewId)}-${atMs}`;
}

function readRecordingCapabilitiesFromSnapshot(
    snapshotCapabilities: BrowserCapabilities | null,
): BrowserRecordingCapabilities {
    return snapshotCapabilities?.recording ?? DEFAULT_RECORDING_CAPABILITIES;
}

function resolveCaptureSource(
    request: BrowserRecordingStartControlRequest,
    machineId: string,
): BrowserRecordingCaptureSourceV1 | undefined {
    if (request.captureKind !== 'streamFrameCapture') return undefined;
    if (request.target.kind === 'streamedBrowser') {
        return {
            kind: 'machineLiveStream',
            streamFamily: 'browser.streamed',
            sourceId: request.target.streamId,
            targetMachineId: machineId,
        };
    }
    if (request.target.kind === 'simulatorPreview') {
        const sourceId = request.target.sourceId ?? request.target.deviceId;
        const streamFamily = simulatorCaptureStreamFamilyV1(sourceId);
        if (!streamFamily) return undefined;
        return {
            kind: 'machineLiveStream',
            streamFamily,
            sourceId,
            targetMachineId: machineId,
        };
    }
    return undefined;
}

function requestCanUseNativeViewCapture(
    request: BrowserRecordingStartControlRequest,
): boolean {
    return request.targetKind === 'externalUrl'
        && request.adapterKind === 'externalUrl'
        && request.renderEngineKind === 'desktopWebView';
}

function resolveRequestCaptureSourceAvailable(input: Readonly<{
    request: BrowserRecordingStartControlRequest;
    captureSource: BrowserRecordingCaptureSourceV1 | undefined;
    nativeViewCaptureHandlerRegistered: boolean;
}>): boolean {
    if (input.request.captureKind === 'streamFrameCapture') {
        return input.captureSource !== undefined;
    }
    if (input.request.captureKind === 'nativeViewCapture') {
        return input.nativeViewCaptureHandlerRegistered
            && requestCanUseNativeViewCapture(input.request);
    }
    return true;
}

function readRecordingFromDaemonResult(result: unknown): BrowserRecordingSessionV1 | null {
    if (!result || typeof result !== 'object' || !('recording' in result)) return null;
    const recording = (result as { recording?: unknown }).recording;
    return recording && typeof recording === 'object'
        ? recording as BrowserRecordingSessionV1
        : null;
}

function mapDaemonUnavailableReasonToUi(
    reason: DaemonBrowserRecordingUnavailableReasonV1,
): BrowserRecordingUnavailableReason {
    if (reason.code === 'browser_recording_retention_unavailable') {
        return {
            reasonCode: 'browser_recording_retention_unavailable',
            policyState: 'retentionLimited',
            message: reason.message,
        };
    }
    if (
        reason.code === 'browser_recording_policy_denied'
        || reason.code === 'browser_recording_permission_denied'
    ) {
        return {
            reasonCode: 'browser_recording_permission_denied',
            policyState: 'permissionDenied',
            message: reason.message,
        };
    }
    const reasonCode: BrowserRecordingUnavailableReason['reasonCode'] = (() => {
        switch (reason.code) {
            case 'browser_recording_adapter_unavailable':
            case 'browser_recording_capture_unavailable':
            case 'browser_recording_mime_unavailable':
            case 'browser_recording_capability_unavailable':
                return reason.code;
            default:
                return 'browser_recording_capture_unavailable';
        }
    })();
    return {
        reasonCode,
        policyState: 'captureUnavailable',
        message: reason.message,
    };
}

export function useSessionBrowserRecordingRuntime(
    params: SessionBrowserRecordingRuntimeInput,
): SessionBrowserRecordingRuntime | null {
    const [state, setState] = React.useState(createBrowserRecordingState);
    const startInFlightByViewIdRef = React.useRef(new Set<string>());
    const snapshot = useServerFeaturesSnapshotForServerId(params.serverId ?? null, {
        enabled: params.enabled && params.recordingCapabilities == null,
    });

    React.useEffect(() => {
        setState(createBrowserRecordingState());
        startInFlightByViewIdRef.current.clear();
    }, [params.scopeKey]);

    const sessionId = params.sessionId;
    const onUnavailable = params.onUnavailable;
    const machineId = typeof params.machineId === 'string' && params.machineId.trim().length > 0
        ? params.machineId.trim()
        : null;
    const serverId = typeof params.serverId === 'string' && params.serverId.trim().length > 0
        ? params.serverId.trim()
        : null;
    const enabled = params.enabled && machineId != null;
    const nowMs = params.nowMs ?? Date.now;
    const recordingCapabilities = params.recordingCapabilities
        ?? readRecordingCapabilitiesFromSnapshot(snapshot.status === 'ready' ? snapshot.features.capabilities.browser : null);
    const nativeViewCaptureHandlerRegistered = useDesktopBrowserRecordingReverseCaptureHandler(machineId);

    const isCaptureSourceAvailable = React.useCallback<NonNullable<BrowserShellRecordingState['isCaptureSourceAvailable']>>((input) => {
        if (!machineId) return false;
        if (input.captureKind === 'nativeViewCapture') {
            return isBrowserRecordingCaptureSourceAvailable({
                view: input.view,
                captureKind: input.captureKind,
                nativeViewCaptureHandlerRegistered,
            });
        }
        if (input.captureKind !== 'streamFrameCapture') return true;
        return resolveCaptureSource({
            browserSessionId: input.view.browserSessionId,
            viewId: input.view.viewId,
            profileId: '',
            target: input.view.target,
            targetKind: input.view.target.kind,
            adapterKind: input.view.adapterKind,
            renderEngineKind: input.view.engineKind,
            captureKind: input.captureKind,
            fidelity: 'unavailable',
            navigationGeneration: input.view.navigationGeneration,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            policyState: 'allowed',
        }, machineId) !== undefined;
    }, [machineId, nativeViewCaptureHandlerRegistered]);

    const onStartRecording = React.useCallback(async (request: BrowserRecordingStartControlRequest) => {
        if (!enabled || !machineId) return;
        if (startInFlightByViewIdRef.current.has(request.viewId)) return;
        startInFlightByViewIdRef.current.add(request.viewId);
        const startedAtMs = nowMs();
        const captureSource = resolveCaptureSource(request, machineId);
        const captureSourceAvailable = resolveRequestCaptureSourceAvailable({
            request,
            captureSource,
            nativeViewCaptureHandlerRegistered,
        });

        try {
            const local = startBrowserRecordingSession({
                state,
                browserRecordingEnabled: true,
                recordingCapabilities,
                browserSessionId: request.browserSessionId,
                viewId: request.viewId,
                profileId: request.profileId,
                targetKind: request.targetKind,
                adapterKind: request.adapterKind,
                renderEngineKind: request.renderEngineKind,
                captureKind: request.captureKind,
                fidelity: request.fidelity,
                navigationGeneration: request.navigationGeneration,
                mimeType: request.mimeType,
                retentionClass: request.retentionClass,
                policyState: request.policyState,
                captureSourceAvailable,
                startedAtMs,
            });
            if (local.status === 'unavailable') {
                onUnavailable?.(local.reason);
                return;
            }

            const result = await startBrowserRecordingViaMachineRpc({
                machineId,
                serverId,
                input: {
                    browserSessionId: request.browserSessionId,
                    viewId: request.viewId,
                    profileId: request.profileId,
                    targetKind: request.targetKind,
                    adapterKind: request.adapterKind,
                    renderEngineKind: request.renderEngineKind,
                    captureKind: request.captureKind,
                    fidelity: request.fidelity,
                    navigationGeneration: request.navigationGeneration,
                    mimeType: request.mimeType,
                    retentionClass: request.retentionClass,
                    policyState: request.policyState,
                    startedAtMs,
                    recordingId: local.recordingId,
                    mediaTarget: {
                        sessionId,
                        messageLocalId: buildRecordingMessageLocalId(request.viewId, startedAtMs),
                    },
                    captureSource,
                },
            });
            const recording = result.ok ? readRecordingFromDaemonResult(result.result) : null;
            if (result.ok && result.result.status === 'unavailable') {
                onUnavailable?.(mapDaemonUnavailableReasonToUi(result.result.reason));
                return;
            }
            if (recording) {
                setState((current) => applyBrowserRecordingSessionSnapshot(current, recording));
            }
        } finally {
            startInFlightByViewIdRef.current.delete(request.viewId);
        }
    }, [
        enabled,
        machineId,
        nativeViewCaptureHandlerRegistered,
        nowMs,
        onUnavailable,
        recordingCapabilities,
        serverId,
        sessionId,
        state,
    ]);

    const onStopRecording = React.useCallback(async (recording: BrowserRecordingSessionV1) => {
        if (!enabled || !machineId) return;
        const result = await stopBrowserRecordingViaMachineRpc({
            machineId,
            serverId,
            recordingId: recording.recordingId,
            navigationGenerationEnd: recording.navigationGenerationEnd ?? recording.navigationGenerationStart,
            stoppedAtMs: nowMs(),
        });
        const updated = result.ok ? readRecordingFromDaemonResult(result.result) : null;
        if (updated) {
            setState((current) => applyBrowserRecordingSessionSnapshot(current, updated));
        }
    }, [enabled, machineId, nowMs, serverId]);

    const onCancelRecording = React.useCallback(async (recording: BrowserRecordingSessionV1) => {
        if (!enabled || !machineId) return;
        const result = await cancelBrowserRecordingViaMachineRpc({
            machineId,
            serverId,
            recordingId: recording.recordingId,
            atMs: nowMs(),
            reason: 'user_canceled',
        });
        const updated = result.ok ? readRecordingFromDaemonResult(result.result) : null;
        if (updated) {
            setState((current) => applyBrowserRecordingSessionSnapshot(current, updated));
        }
    }, [enabled, machineId, nowMs, serverId]);

    return React.useMemo(() => {
        if (!enabled) return null;
        return {
            state,
            browserShellRecording: {
                state,
                recordingCapabilities,
                enabled: true,
                policyState: 'allowed',
                nowMs,
                onStartRecording,
                onStopRecording,
                onCancelRecording,
                onUnavailable,
                isCaptureSourceAvailable,
            },
        };
    }, [
        enabled,
        isCaptureSourceAvailable,
        nowMs,
        onCancelRecording,
        onStartRecording,
        onStopRecording,
        onUnavailable,
        recordingCapabilities,
        state,
    ]);
}
