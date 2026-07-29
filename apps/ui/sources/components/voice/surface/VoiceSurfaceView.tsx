import * as React from 'react';
import { Platform, View } from 'react-native';

import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import { t } from '@/text';
import { VoiceDiagnosticsIndicator } from '@/voice/diagnostics/VoiceDiagnosticsIndicator';

import { VoiceActivityPanel } from './VoiceActivityPanel';
import { VoiceSurfaceContainer } from './VoiceSurfaceContainer';
import { VoiceSurfaceControls } from './VoiceSurfaceControls';
import { VoiceSurfaceHeader } from './VoiceSurfaceHeader';
import { VoiceSurfaceMotionFrame } from './VoiceSurfaceMotionFrame';
import type { VoiceSurfaceViewModel } from './useVoiceSurfaceModel';

export const VoiceSurfaceView = React.memo(function VoiceSurfaceView(props: Readonly<{
    model: VoiceSurfaceViewModel;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const statusFocusRef = React.useRef<NonNullable<FocusReturnTarget> | null>(null);
    const surfaceTestId = `voice-surface:${props.model.variant}`;
    const modeTestId = `voice-surface-mode:${props.model.variant}:${props.model.mode}`;

    const statusInfo = (() => {
        switch (props.model.surfaceState) {
            case 'connecting':
                return { dot: theme.colors.status.connecting, label: t('voiceAssistant.connecting') };
            case 'reconnecting':
                return { dot: theme.colors.status.connecting, label: t('voiceAssistant.reconnecting') };
            case 'listening':
                return { dot: theme.colors.status.connected, label: t('voiceAssistant.listening') };
            case 'thinking':
                return { dot: theme.colors.status.connecting, label: t('voiceAssistant.thinking') };
            case 'speaking':
                return { dot: theme.colors.status.connected, label: t('voiceAssistant.speaking') };
            case 'permission_required':
                return { dot: theme.colors.status.error, label: t('voiceAssistant.microphonePermissionRequired') };
            case 'interrupted':
                return { dot: theme.colors.status.connecting, label: t('voiceAssistant.interrupted') };
            case 'error':
                return { dot: theme.colors.status.error, label: t('voiceAssistant.connectionError') };
            case 'idle':
            default:
                return { dot: theme.colors.status.default, label: t('voiceAssistant.label') };
        }
    })();

    const containerStyle = [
        styles.container,
        {
            backgroundColor: theme.colors.surface.base,
        },
        props.model.style,
    ];

    return (
        <VoiceSurfaceMotionFrame surfaceState={props.model.surfaceState}>
        <VoiceSurfaceContainer testID={surfaceTestId} style={containerStyle}>
            <View testID={modeTestId} collapsable={false} style={styles.hiddenMarker} />
            <View style={styles.headerRow}>
                    <VoiceSurfaceHeader
                        announceSubtitle={props.model.canRecover}
                        bargeInLabel={t('voiceSurface.a11y.bargeIn')}
                        canBargeIn={props.model.canBargeIn}
                        isMicCaptureActive={props.model.isMicCaptureActive}
                        isMuted={props.model.isMuted}
                        surfaceState={props.model.surfaceState}
                        micBadgeStyle={{ backgroundColor: theme.colors.surface.inset, borderColor: theme.colors.border.default }}
                        micIconColor={theme.colors.text.primary}
                        microphoneActiveLabel={t('voiceSurface.a11y.microphoneActive')}
                        microphoneInactiveLabel={t('voiceSurface.a11y.microphoneInactive')}
                        microphoneMutedLabel={t('voiceSurface.a11y.microphoneMuted')}
                        onBargeIn={props.model.onBargeIn}
                        dataDisclosureLabel={t('voiceSurface.a11y.providerDataDisclosure', {
                            provider: props.model.providerLabel ?? t('voiceAssistant.label'),
                        })}
                        dataDisclosureTestID={`voice-surface-data:${props.model.variant}`}
                        onOpenDataDisclosure={props.model.onOpenDataDisclosure}
                        showDataDisclosure={props.model.hasProviderDataDisclosure}
                        statusDotColor={statusInfo.dot}
                        statusFocusRef={statusFocusRef}
                        statusLabel={statusInfo.label}
                        providerLabel={props.model.providerLabel}
                        statusTestID={`voice-surface-status:${props.model.variant}:${props.model.status}`}
                        statusTextColor={theme.colors.text.primary}
                        styles={styles}
                        subtitle={props.model.subtitle}
                        subtitleColor={theme.colors.text.secondary}
                    />

                    <VoiceSurfaceControls
                        cancelTurnLabel={t('voiceSurface.a11y.cancelTurn')}
                        canCancelTurn={props.model.canCancelTurn}
                        canMute={props.model.canMute}
                        canOpenConversation={props.model.canOpenConversation}
                        canRecover={props.model.canRecover}
                        canStop={props.model.canStop}
                        canTeleportToSessionRoot={props.model.canTeleportToSessionRoot}
                        controlsActive={props.model.controlsActive}
                        controlsDisabled={props.model.controlsDisabled}
                        controlsLoading={props.model.controlsLoading}
                        showStartStopAction={props.model.surfaceState !== 'error'}
                        isMuted={props.model.isMuted}
                        muteLabel={props.model.muteLabel}
                        cancelTestID={`voice-surface-cancel:${props.model.variant}`}
                        openConversationTestID={`voice-surface-open:${props.model.variant}`}
                        openLabel={t('voiceSurface.a11y.openConversation')}
                        recoveryLabel={props.model.recoveryLabel}
                        recoveryTestID={`voice-surface-recovery:${props.model.variant}`}
                        startStopLabel={props.model.startStopLabel}
                        styles={styles}
                        textColor={theme.colors.text.secondary}
                        teleportLabel={t('voiceSurface.a11y.teleport')}
                        tintColor={theme.colors.button?.primary?.tint ?? theme.colors.text.primary}
                        toggleTestID={`voice-surface-toggle:${props.model.variant}`}
                        onCancelTurn={props.model.onCancelTurn}
                        onToggleMute={props.model.onToggleMute}
                        onOpenConversation={props.model.onOpenConversation}
                        onRecover={props.model.onRecover}
                        onTeleport={props.model.onTeleport}
                        onToggle={props.model.onTogglePress}
                    />
            </View>

            <View style={styles.diagnosticsRow}>
                <VoiceDiagnosticsIndicator
                    focusFallbackRef={statusFocusRef}
                    sessionId={props.model.diagnosticsSessionId}
                />
            </View>

            {props.model.activityFeedEnabled ? (
                <VoiceActivityPanel
                    count={props.model.transcriptEntries.length}
                    countTestID={`voice-surface-activity-count:${props.model.variant}`}
                    emptyLabel={t('voiceActivity.empty')}
                    entryTestIdPrefix={`voice-surface-activity-entry:${props.model.variant}:`}
                    expanded={props.model.expanded}
                    entries={props.model.visibleTranscriptEntries}
                    eventTextColor={theme.colors.text.primary}
                    onToggleExpanded={props.model.onToggleExpanded}
                    styles={styles}
                    title={t('voiceActivity.title')}
                    titleColor={theme.colors.text.secondary}
                    toggleLabel={props.model.toggleActivityLabel}
                    toggleTestID={`voice-surface-activity-toggle:${props.model.variant}`}
                    expandEntryLabel={t('toolView.showFullContent')}
                    collapseEntryLabel={t('toolView.showLessContent')}
                    partialLabel={t('voiceActivity.partial')}
                    correctedLabel={t('voiceActivity.corrected')}
                    interruptedLabel={t('voiceAssistant.interrupted')}
                />
            ) : null}
        </VoiceSurfaceContainer>
        </VoiceSurfaceMotionFrame>
    );
});

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignSelf: 'stretch',
        marginHorizontal: 16,
        marginTop: 10,
        marginBottom: 8,
        borderRadius: 12,
        overflow: 'hidden',
    },
    headerRow: {
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        rowGap: 6,
    },
    hiddenMarker: {
        position: 'absolute',
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
    },
    diagnosticsRow: {
        paddingHorizontal: 12,
    },
    statusLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        paddingRight: 10,
    },
    micBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        minHeight: 44,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
    },
    dot: {
        marginRight: 6,
    },
    micIcon: {
        marginTop: Platform.select({ ios: -0.5, default: 0 }),
    },
    statusTextCol: {
        minWidth: 0,
        flexShrink: 1,
    },
    statusTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        flexWrap: 'wrap',
    },
    statusText: {
        flexShrink: 1,
        fontSize: 14,
        fontWeight: '600',
    },
    providerText: {
        flexShrink: 1,
        fontSize: 11,
        fontWeight: '500',
    },
    targetText: {
        flexShrink: 1,
        marginTop: 2,
        fontSize: 12,
    },
    statusRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
    },
    iconAction: {
        minWidth: 44,
        minHeight: 44,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
    },
    primaryAction: {
        minWidth: 44,
        minHeight: 44,
    },
    recoveryAction: {
        minHeight: 44,
        paddingHorizontal: 10,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    recoveryActionText: {
        fontSize: 13,
        fontWeight: '600',
    },
    feedContainer: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    feedHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        paddingVertical: 0,
        minHeight: 44,
    },
    feedHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    feedTitle: {
        fontSize: 12,
        fontWeight: '600',
    },
    feedCount: {
        fontSize: 12,
    },
    feedScroll: {
        maxHeight: 220,
    },
    feedScrollContent: {
        paddingHorizontal: 12,
        paddingBottom: 12,
        gap: 8,
    },
    emptyText: {
        fontSize: 14,
    },
    eventText: {
        fontSize: 14,
        lineHeight: runtime.fontScale * 18,
    },
    eventRow: {
        gap: 2,
    },
    eventRevealAction: {
        alignSelf: 'flex-start',
        justifyContent: 'center',
        borderRadius: 8,
        paddingHorizontal: 6,
    },
    eventRevealText: {
        fontSize: 11,
        fontWeight: '600',
        textDecorationLine: 'underline',
    },
    provisionalEventText: {
        opacity: 0.72,
        fontStyle: 'italic',
    },
    revisionLabel: {
        fontSize: 11,
        fontWeight: '600',
    },
    liveRegion: {
        position: 'absolute',
        left: -10_000,
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
}));
