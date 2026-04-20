import * as React from 'react';
import { Platform, View } from 'react-native';

import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';

import { VoiceActivityPanel } from './VoiceActivityPanel';
import { VoiceSurfaceContainer } from './VoiceSurfaceContainer';
import { VoiceSurfaceControls } from './VoiceSurfaceControls';
import { VoiceSurfaceHeader } from './VoiceSurfaceHeader';
import type { VoiceSurfaceViewModel } from './useVoiceSurfaceModel';

export function VoiceSurfaceView(props: Readonly<{
    model: VoiceSurfaceViewModel;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isWeb = Platform.OS === 'web';
    const surfaceTestId = `voice-surface:${props.model.variant}`;
    const modeTestId = `voice-surface-mode:${props.model.variant}:${props.model.mode}`;

    const statusInfo = (() => {
        switch (props.model.status) {
            case 'connecting':
                return { dot: theme.colors.status.connecting, label: t('voiceAssistant.connecting') };
            case 'connected':
                return { dot: theme.colors.status.connected, label: t('voiceAssistant.active') };
            case 'error':
                return { dot: theme.colors.status.error, label: t('voiceAssistant.connectionError') };
            case 'disconnected':
            default:
                return { dot: theme.colors.status.default, label: t('voiceAssistant.label') };
        }
    })();

    const containerStyle = [
        styles.container,
        {
            backgroundColor: theme.colors.surface,
        },
        props.model.style,
    ];

    return (
        <VoiceSurfaceContainer testID={surfaceTestId} style={containerStyle}>
            <View testID={modeTestId} collapsable={false} style={styles.hiddenMarker} />
            <View style={styles.headerRow}>
                    <VoiceSurfaceHeader
                        bargeInLabel={t('voiceSurface.a11y.bargeIn')}
                        canBargeIn={props.model.canBargeIn}
                        isConnecting={props.model.isConnecting}
                        isListening={props.model.isListening}
                        micBadgeStyle={{ backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }}
                        micIconColor={theme.colors.text}
                        onBargeIn={props.model.onBargeIn}
                        statusDotColor={statusInfo.dot}
                        statusLabel={statusInfo.label}
                        statusTestID={`voice-surface-status:${props.model.variant}:${props.model.status}`}
                        statusTextColor={theme.colors.text}
                        styles={styles}
                        subtitle={props.model.subtitle}
                        subtitleColor={theme.colors.textSecondary}
                    />

                    <VoiceSurfaceControls
                        cancelTurnLabel={t('voiceSurface.a11y.cancelTurn')}
                        canCancelTurn={props.model.canCancelTurn}
                        canMute={props.model.canMute}
                        canOpenConversation={props.model.canOpenConversation}
                        canStop={props.model.canStop}
                        canTeleportToSessionRoot={props.model.canTeleportToSessionRoot}
                        controlsActive={props.model.controlsActive}
                        controlsDisabled={props.model.controlsDisabled}
                        controlsLoading={props.model.controlsLoading}
                        isSpeaking={props.model.isSpeaking}
                        isMuted={props.model.isMuted}
                        muteLabel={props.model.muteLabel}
                        cancelTestID={`voice-surface-cancel:${props.model.variant}`}
                        openConversationTestID={`voice-surface-open:${props.model.variant}`}
                        openLabel={props.model.openLabel}
                        startStopLabel={props.model.startStopLabel}
                        styles={styles}
                        textColor={theme.colors.textSecondary}
                        teleportLabel={t('voiceSurface.a11y.teleport')}
                        tintColor={theme.colors.button?.primary?.tint ?? theme.colors.text}
                        toggleTestID={`voice-surface-toggle:${props.model.variant}`}
                        onCancelTurn={props.model.onCancelTurn}
                        onToggleMute={props.model.onToggleMute}
                        onOpenConversation={props.model.onOpenConversation}
                        onTeleport={props.model.onTeleport}
                        onToggle={props.model.onTogglePress}
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
                    eventTextColor={theme.colors.text}
                    onToggleExpanded={props.model.onToggleExpanded}
                    styles={styles}
                    title={t('voiceActivity.title')}
                    titleColor={theme.colors.textSecondary}
                    toggleLabel={props.model.toggleActivityLabel}
                    toggleTestID={`voice-surface-activity-toggle:${props.model.variant}`}
                />
            ) : null}
        </VoiceSurfaceContainer>
    );
}

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
    },
    hiddenMarker: {
        position: 'absolute',
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
    },
    statusLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        paddingRight: 10,
    },
    micBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        height: 28,
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
        flexShrink: 1,
    },
    statusText: {
        fontSize: 14,
        fontWeight: '600',
    },
    targetText: {
        marginTop: 2,
        fontSize: 12,
    },
    statusRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    iconAction: {
        width: 28,
        height: 28,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
    },
    feedContainer: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    feedHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        paddingVertical: 10,
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
}));
