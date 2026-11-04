import type {
    BrowserCapabilities,
    BrowserRecordingCapabilities} from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type {
    BrowserRecordingCaptureSourceV1,
    DaemonBrowserRecordingUnavailableReasonV1,
    BrowserRecordingSessionV1,
} from '@happier-dev/protocol/browser/recording/v1';
import { DEFAULT_BROWSER_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { simulatorCaptureStreamFamilyV1 } from '@happier-dev/protocol/devices/simulator/v1';
import {
    DaemonBrowserRecordingStartResultV1Schema,
    DaemonBrowserRecordingStopResultV1Schema,
    DaemonBrowserRecordingTerminalResultV1Schema,
} from '@happier-dev/protocol/browser/recording/v1';
import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

import type { BrowserShellRecordingState } from '@/components/browser/BrowserShell';
import type { BrowserRecordingStartControlRequest } from '@/components/browser/recording';
import {
    applyBrowserRecordingSessionSnapshot,
    createBrowserRecordingState,
    type BrowserRecordingState,
    type BrowserRecordingUnavailableReason,
} from '@/sync/domains/browser/recording';
import {
    isBrowserRecordingCaptureSourceAvailable,
    useDesktopBrowserRecordingReverseCaptureHandler,
} from '@/sync/domains/browser/recording/reverseCaptureAvailability';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { Modal } from '@/modal';
import { t } from '@/text';

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
            sourceId: browserViewKey(request),
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

/**
 * One visible outcome for a stop or discard that did not happen (H-UX F-4, plan §437). A transport
 * failure, a daemon refusal and a finalization that failed are the same product event: the clip is
 * not where the user asked it to be. Success says nothing here (the recording state changing is the
 * evidence), and the daemon's technical reason message is never shown raw.
 */
function presentBrowserRecordingActionFailure(action: 'stop' | 'discard'): void {
    if (action === 'stop') {
        Modal.alert(t('browserRecording.failure.stopTitle'), t('browserRecording.failure.stopBody'));
        return;
    }
    Modal.alert(t('browserRecording.failure.discardTitle'), t('browserRecording.failure.discardBody'));
}

export function useSessionBrowserRecordingRuntime(
    params: SessionBrowserRecordingRuntimeInput,
): SessionBrowserRecordingRuntime | null {
    const [state, setState] = React.useState(createBrowserRecordingState);
    const startInFlightByViewIdRef = React.useRef(new Set<string>());
    const presented = useLayoutPresentationActive();
    const requestScope = React.useRef<AbortController | null>(null);
    const snapshot = useServerFeaturesSnapshotForServerId(params.serverId ?? null, {
        enabled: params.enabled && params.recordingCapabilities == null,
    });

    React.useEffect(() => {
        setState(createBrowserRecordingState());
    }, [params.scopeKey, params.sessionId, params.machineId, params.serverId]);

    React.useEffect(() => {
        if (!params.enabled || !presented) return;
        const controller = new AbortController();
        requestScope.current = controller;
        startInFlightByViewIdRef.current = new Set();
        return () => {
            controller.abort();
            if (requestScope.current === controller) requestScope.current = null;
        };
    }, [params.scopeKey, params.sessionId, params.machineId, params.serverId, params.enabled, presented]);

    const sessionId = params.sessionId;
    const onUnavailable = params.onUnavailable;
    const machineId = typeof params.machineId === 'string' && params.machineId.trim().length > 0
        ? params.machineId.trim()
        : null;
    const serverId = typeof params.serverId === 'string' && params.serverId.trim().length > 0
        ? params.serverId.trim()
        : null;
    const { execute, isCurrent, ready, approval } = useMountedActionExecution(serverId, { retainInvocation: true });
    const approvalReview = useInPlaceApprovalReview(approval);
    const enabled = params.enabled && machineId != null && presented && ready;
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
        const signal = requestScope.current?.signal;
        if (!signal || signal.aborted) return;
        const pending = startInFlightByViewIdRef.current;
        if (pending.has(request.viewId)) {
            approvalReview.reopen();
            return;
        }
        pending.add(request.viewId);
        const startedAtMs = nowMs();
        const captureSource = resolveCaptureSource(request, machineId);

        try {
            const result = await execute('browser.recording.start', {
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
                mediaTarget: {
                    sessionId,
                    messageLocalId: buildRecordingMessageLocalId(request.viewId, startedAtMs),
                },
                captureSource,
            }, {
                signal,
                defaultSessionId: sessionId,
                externalActionTarget: { kind: 'machine', machineId },
            });
            if (signal.aborted || !isCurrent()) return;
            const parsed = result.ok ? DaemonBrowserRecordingStartResultV1Schema.safeParse(result.result) : null;
            if (!parsed?.success) return;
            const recording = readRecordingFromDaemonResult(parsed.data);
            if (parsed.data.status === 'unavailable') {
                onUnavailable?.(mapDaemonUnavailableReasonToUi(parsed.data.reason));
                return;
            }
            if (recording) {
                setState((current) => applyBrowserRecordingSessionSnapshot(current, recording));
            }
        } catch {
            // A refused or unavailable start never creates a local active recording.
        } finally {
            pending.delete(request.viewId);
        }
    }, [
        approvalReview.reopen,
        enabled,
        execute,
        isCurrent,
        machineId,
        nowMs,
        onUnavailable,
        sessionId,
    ]);

    const onStopRecording = React.useCallback(async (recording: BrowserRecordingSessionV1) => {
        if (!enabled || !machineId) return;
        const signal = requestScope.current?.signal;
        if (!signal || signal.aborted) return;
        try {
            const result = await execute('browser.recording.stop', {
                recordingId: recording.recordingId,
                navigationGenerationEnd: recording.navigationGenerationEnd ?? recording.navigationGenerationStart,
                stoppedAtMs: nowMs(),
            }, { signal, defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId } });
            if (signal.aborted || !isCurrent()) return;
            const parsed = result.ok ? DaemonBrowserRecordingStopResultV1Schema.safeParse(result.result) : null;
            const updated = parsed?.success ? readRecordingFromDaemonResult(parsed.data) : null;
            if (updated) {
                setState((current) => applyBrowserRecordingSessionSnapshot(current, updated));
            }
            if (!parsed?.success || parsed.data.status === 'unavailable' || parsed.data.status === 'failed') {
                presentBrowserRecordingActionFailure('stop');
            }
        } catch {
            if (!signal.aborted && isCurrent()) presentBrowserRecordingActionFailure('stop');
        }
    }, [enabled, execute, isCurrent, machineId, nowMs, sessionId]);

    const onCancelRecording = React.useCallback(async (recording: BrowserRecordingSessionV1) => {
        if (!enabled || !machineId) return;
        const signal = requestScope.current?.signal;
        if (!signal || signal.aborted) return;
        try {
            const result = await execute('browser.recording.cancel', {
                recordingId: recording.recordingId,
                atMs: nowMs(),
                reason: 'user_canceled',
            }, { signal, defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId } });
            if (signal.aborted || !isCurrent()) return;
            const parsed = result.ok ? DaemonBrowserRecordingTerminalResultV1Schema.safeParse(result.result) : null;
            const updated = parsed?.success ? readRecordingFromDaemonResult(parsed.data) : null;
            if (updated) {
                setState((current) => applyBrowserRecordingSessionSnapshot(current, updated));
            }
            if (!parsed?.success || parsed.data.status === 'unavailable' || parsed.data.status === 'failed') {
                presentBrowserRecordingActionFailure('discard');
            }
        } catch {
            if (!signal.aborted && isCurrent()) presentBrowserRecordingActionFailure('discard');
        }
    }, [enabled, execute, isCurrent, machineId, nowMs, sessionId]);

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
