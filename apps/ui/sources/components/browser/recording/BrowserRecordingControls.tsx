import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
    BrowserDiagnosticFidelityV1,
    BrowserRecordingCapabilities,
    BrowserRecordingCaptureKindV1,
    BrowserRecordingPolicyStateV1,
    BrowserRecordingRetentionClassV1,
    BrowserRecordingSessionV1,
} from '@happier-dev/protocol';
import { resolveBrowserRecordingCaptureProfile } from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import {
    resolveBrowserRecordingAvailability,
    type BrowserRecordingState,
    type BrowserRecordingUnavailableReason,
} from '@/sync/domains/browser/recording';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    statusPill: {
        minHeight: 34,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusPillActive: {
        borderColor: theme.colors.state.danger.foreground,
    },
    statusText: {
        color: theme.colors.text.secondary,
    },
    statusTextActive: {
        color: theme.colors.state.danger.foreground,
    },
}));

export type BrowserRecordingStartControlRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    profileId: string;
    target: BrowserControlViewState['target'];
    targetKind: BrowserControlViewState['target']['kind'];
    adapterKind: BrowserControlViewState['adapterKind'];
    renderEngineKind: BrowserControlViewState['engineKind'];
    captureKind: BrowserRecordingCaptureKindV1;
    fidelity: BrowserDiagnosticFidelityV1;
    navigationGeneration: number;
    mimeType: string;
    retentionClass: BrowserRecordingRetentionClassV1;
    policyState: BrowserRecordingPolicyStateV1;
}>;

export type BrowserRecordingControlsProps = Readonly<{
    view: BrowserControlViewState | null;
    profileId: string | null;
    state: BrowserRecordingState;
    recordingCapabilities: BrowserRecordingCapabilities;
    enabled?: boolean;
    policyState?: BrowserRecordingPolicyStateV1;
    captureKind?: BrowserRecordingCaptureKindV1;
    fidelity?: BrowserDiagnosticFidelityV1;
    mimeType?: string;
    retentionClass?: BrowserRecordingRetentionClassV1;
    nowMs?: () => number;
    onStartRecording?: (request: BrowserRecordingStartControlRequest) => void;
    onStopRecording?: (recording: BrowserRecordingSessionV1) => void;
    onCancelRecording?: (recording: BrowserRecordingSessionV1) => void;
    onUnavailable?: (reason: BrowserRecordingUnavailableReason) => void;
    isCaptureSourceAvailable?: (input: Readonly<{
        view: BrowserControlViewState;
        captureKind: BrowserRecordingCaptureKindV1;
    }>) => boolean;
    testID?: string;
}>;

function resolveFidelity(
    props: BrowserRecordingControlsProps,
): BrowserDiagnosticFidelityV1 {
    return props.fidelity
        ?? props.view?.adapterCapabilities.diagnosticsFidelityByFamily.screenshot
        ?? 'unavailable';
}

function resolveFidelityLabel(fidelity: BrowserDiagnosticFidelityV1): string {
    switch (fidelity) {
        case 'cdp':
            return t('browserRecording.fidelity.cdp');
        case 'injectedPage':
            return t('browserRecording.fidelity.injectedPage');
        case 'nativeCallback':
            return t('browserRecording.fidelity.nativeCallback');
        case 'streamFrame':
            return t('browserRecording.fidelity.streamFrame');
        case 'previewProxy':
            return t('browserRecording.fidelity.previewProxy');
        case 'unavailable':
            return t('browserRecording.fidelity.unavailable');
    }
}

function findActiveRecording(
    state: BrowserRecordingState,
    view: BrowserControlViewState | null,
): BrowserRecordingSessionV1 | null {
    if (!view) return null;
    const recordingId = state.activeRecordingIdByViewId[view.viewId];
    return recordingId ? state.sessionsById[recordingId] ?? null : null;
}

function resolveCaptureSourceAvailable(
    props: BrowserRecordingControlsProps,
): boolean | undefined {
    if (!props.view) return undefined;
    if (props.captureKind) {
        return props.isCaptureSourceAvailable?.({
            view: props.view,
            captureKind: props.captureKind,
        }) ?? false;
    }
    return (
        props.isCaptureSourceAvailable?.({ view: props.view, captureKind: 'nativeViewCapture' }) === true
        || props.isCaptureSourceAvailable?.({ view: props.view, captureKind: 'streamFrameCapture' }) === true
    );
}

function formatElapsedLabel(recording: BrowserRecordingSessionV1, nowMs: number): string {
    const elapsedMs = recording.status === 'recording'
        ? Math.max(0, nowMs - recording.startedAtMs)
        : recording.durationMs;
    const elapsedSeconds = Math.floor(elapsedMs / 1_000);
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function resolveUnavailableStatusId(reason: BrowserRecordingUnavailableReason): string {
    if (reason.policyState === 'permissionDenied' || reason.reasonCode === 'browser_recording_permission_denied') {
        return 'permission-denied';
    }
    if (
        reason.policyState === 'captureUnavailable'
        || reason.reasonCode === 'browser_recording_capability_unavailable'
        || reason.reasonCode === 'browser_recording_adapter_unavailable'
        || reason.reasonCode === 'browser_recording_capture_unavailable'
        || reason.reasonCode === 'browser_recording_mime_unavailable'
    ) {
        return 'capture-unavailable';
    }
    if (
        reason.policyState === 'retentionLimited'
        || reason.reasonCode === 'browser_recording_retention_unavailable'
    ) {
        return 'retention-limit';
    }
    return 'unavailable';
}

function resolveRecordingRetentionStatusId(recording: BrowserRecordingSessionV1): 'attached' | 'discarded' | 'temporary' {
    if (recording.status === 'discarded' || recording.status === 'expired') {
        return 'discarded';
    }
    if (recording.retentionClass === 'attached') {
        return 'attached';
    }
    return 'temporary';
}

function resolveRecordingRetentionLabel(recording: BrowserRecordingSessionV1): string {
    switch (resolveRecordingRetentionStatusId(recording)) {
        case 'attached':
            return t('browserRecording.status.attached');
        case 'discarded':
            return t('browserRecording.status.discarded');
        case 'temporary':
            return t('browserRecording.status.temporary');
    }
}

export function BrowserRecordingControls(props: BrowserRecordingControlsProps): React.ReactElement {
    const testID = props.testID ?? 'browser-recording-controls';
    const activeRecording = findActiveRecording(props.state, props.view);
    const captureSourceAvailable = resolveCaptureSourceAvailable(props);
    const captureProfile = props.view
        ? resolveBrowserRecordingCaptureProfile({
            recordingCapabilities: props.recordingCapabilities,
            adapterKind: props.view.adapterKind,
            renderEngineKind: props.view.engineKind,
            captureKind: props.captureKind,
            mimeType: props.mimeType,
            retentionClass: props.retentionClass,
            captureSourceAvailable,
        })
        : null;
    const captureKind = captureProfile?.captureKind ?? props.captureKind ?? 'unavailable';
    const mimeType = captureProfile?.mimeType ?? props.mimeType ?? 'video/webm';
    const retentionClass = captureProfile?.retentionClass ?? props.retentionClass ?? 'preSend';
    const fidelity = props.fidelity ?? captureProfile?.fidelity ?? resolveFidelity(props);
    const policyState = props.policyState ?? 'allowed';
    const unavailable = props.view && props.profileId
        ? resolveBrowserRecordingAvailability({
            browserRecordingEnabled: props.enabled !== false,
            recordingCapabilities: props.recordingCapabilities,
            adapterKind: props.view.adapterKind,
            renderEngineKind: props.view.engineKind,
            captureKind,
            mimeType,
            retentionClass,
            policyState,
            captureSourceAvailable,
        })
        : {
            reasonCode: 'browser_recording_capability_unavailable',
            policyState: 'captureUnavailable',
            message: t('browserRecording.status.noView'),
        } satisfies BrowserRecordingUnavailableReason;
    const canStart = !activeRecording
        && !unavailable
        && Boolean(props.view)
        && Boolean(props.profileId)
        && Boolean(props.onStartRecording);

    const startRecording = React.useCallback(() => {
        if (!props.view || !props.profileId) {
            if (unavailable) props.onUnavailable?.(unavailable);
            return;
        }
        if (unavailable) {
            props.onUnavailable?.(unavailable);
            return;
        }
        props.onStartRecording?.({
            browserSessionId: props.view.browserSessionId,
            viewId: props.view.viewId,
            profileId: props.profileId,
            target: props.view.target,
            targetKind: props.view.target.kind,
            adapterKind: props.view.adapterKind,
            renderEngineKind: props.view.engineKind,
            captureKind,
            fidelity,
            navigationGeneration: props.view.navigationGeneration,
            mimeType,
            retentionClass,
            policyState,
        });
    }, [captureKind, fidelity, mimeType, policyState, props, retentionClass, unavailable]);

    const stopRecording = React.useCallback(() => {
        if (!activeRecording) return;
        props.onStopRecording?.(activeRecording);
    }, [activeRecording, props]);

    const cancelRecording = React.useCallback(() => {
        if (!activeRecording) return;
        props.onCancelRecording?.(activeRecording);
    }, [activeRecording, props]);

    return (
        <View testID={testID} style={stylesheet.root}>
            {activeRecording ? (
                <>
                    <View
                        testID={`${testID}-status-recording`}
                        style={[stylesheet.statusPill, stylesheet.statusPillActive]}
                    >
                        <Text style={[stylesheet.statusText, stylesheet.statusTextActive]}>
                            {t('browserRecording.status.recording', {
                                elapsed: formatElapsedLabel(activeRecording, props.nowMs?.() ?? Date.now()),
                                fidelity: resolveFidelityLabel(activeRecording.fidelity),
                            })}
                        </Text>
                    </View>
                    <View
                        testID={`${testID}-status-${resolveRecordingRetentionStatusId(activeRecording)}`}
                        style={stylesheet.statusPill}
                    >
                        <Text style={stylesheet.statusText}>
                            {resolveRecordingRetentionLabel(activeRecording)}
                        </Text>
                    </View>
                    <IconButton
                        testID={`${testID}-stop`}
                        iconName="stop"
                        accessibilityLabel={t('browserRecording.actions.stop')}
                        tooltip={t('browserRecording.actions.stop')}
                        size={34}
                        disabled={!props.onStopRecording}
                        onPress={stopRecording}
                    />
                    <IconButton
                        testID={`${testID}-cancel`}
                        iconName="close-outline"
                        accessibilityLabel={t('browserRecording.actions.cancel')}
                        tooltip={t('browserRecording.actions.cancel')}
                        size={34}
                        disabled={!props.onCancelRecording}
                        onPress={cancelRecording}
                    />
                </>
            ) : (
                <>
                    <View
                        testID={`${testID}-status-${unavailable ? resolveUnavailableStatusId(unavailable) : 'ready'}`}
                        style={stylesheet.statusPill}
                    >
                        <Text style={stylesheet.statusText}>
                            {unavailable
                                ? t('browserRecording.status.unavailable', { reason: unavailable.message })
                                : t('browserRecording.status.ready', { fidelity: resolveFidelityLabel(fidelity) })}
                        </Text>
                    </View>
                    <IconButton
                        testID={`${testID}-start`}
                        iconName="ellipse"
                        accessibilityLabel={t('browserRecording.actions.start')}
                        tooltip={t('browserRecording.actions.start')}
                        disabledReason={unavailable?.message ?? undefined}
                        size={34}
                        disabled={!canStart}
                        onPress={startRecording}
                    />
                </>
            )}
        </View>
    );
}
