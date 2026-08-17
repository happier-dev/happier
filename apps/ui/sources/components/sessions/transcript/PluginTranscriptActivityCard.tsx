import * as React from 'react';
import {
    AccessibilityInfo,
    Platform,
    StyleSheet,
    View,
} from 'react-native';
import {
    HAPPIER_TONE_COLOR_TOKEN,
    HappierProgress,
} from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { ProgressChecklist } from '@/components/systemTasks/ProgressChecklist';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
    resolvePluginTranscriptActivityCanDismiss,
    resolvePluginTranscriptActivityPresentation,
    type PluginTranscriptActivityItem,
} from './pluginTranscriptActivityPresentation';

const styles = StyleSheet.create({
    accessibilityStatus: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
    progress: {
        width: 72,
        flexShrink: 0,
    },
});

/**
 * A presentation-only announcement adapter. Counter updates stay visible and
 * queryable on the progressbar, while the semantic transition key coalesces
 * live announcements. It holds no activity lifecycle or Resource state.
 */
const PluginTranscriptActivityAccessibilityStatus = React.memo(
    function PluginTranscriptActivityAccessibilityStatus(props: Readonly<{
        announcement: string;
        transitionKey: string;
    }>) {
        const lastIosTransitionRef = React.useRef<string | null>(null);
        const pointerEvents = resolveOverlayPointerEvents('none');

        React.useEffect(() => {
            if (
                Platform.OS !== 'ios'
                || lastIosTransitionRef.current === props.transitionKey
            ) {
                return;
            }
            lastIosTransitionRef.current = props.transitionKey;
            try {
                AccessibilityInfo.announceForAccessibility(props.announcement);
            } catch {
                // Assistive-technology announcements are best effort.
            }
        }, [props.announcement, props.transitionKey]);

        if (Platform.OS === 'ios') return null;
        return (
            <View
                testID="plugin-transcript-activity-a11y-status"
                accessible
                accessibilityLiveRegion="polite"
                pointerEvents={pointerEvents.nativePointerEvents}
                style={[styles.accessibilityStatus, pointerEvents.webStyle]}
                {...({
                    role: 'status',
                    'aria-live': 'polite',
                    'aria-atomic': true,
                } as Record<string, unknown>)}
            >
                <Text>{props.announcement}</Text>
            </View>
        );
    },
);

/**
 * Presentation-only Resource activity card. Its final transcript item already
 * contains only Session-admitted Actions, while opening one still delegates to
 * the canonical current Session controller. The card never creates a caller,
 * input, dispatcher, cache, or second admission decision.
 */
export const PluginTranscriptActivityCard = React.memo(
    function PluginTranscriptActivityCard(props: Readonly<{
        activity: PluginTranscriptActivityItem;
        onDismiss: (identityKey: string) => void;
        onOpenAction: (action: Readonly<{ pluginId: string; localId: string }>) => void;
    }>) {
        const { theme } = useUnistyles();
        const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
        const canDismiss = resolvePluginTranscriptActivityCanDismiss(props.activity);
        const presentation = React.useMemo(
            () => resolvePluginTranscriptActivityPresentation(props.activity),
            [props.activity],
        );
        return (
            <View testID="plugin-transcript-activity-card">
                <PluginTranscriptActivityAccessibilityStatus
                    announcement={presentation.announcement}
                    transitionKey={presentation.announcementKey}
                />
                <ItemGroup title={props.activity.title}>
                    <Item
                        testID="plugin-transcript-activity-status"
                        title={presentation.statusTitle}
                        subtitle={presentation.statusDetail}
                        leftElement={(
                            <StatusDot
                                color={presentationTheme.colors[
                                    HAPPIER_TONE_COLOR_TOKEN[presentation.tone]
                                ]}
                                isPulsing={presentation.isPulsing}
                            />
                        )}
                        rightElement={presentation.progress ? (
                            <HappierProgress
                                testID="plugin-transcript-activity-progress"
                                label={presentation.accessibilityLabel}
                                value={presentation.progress.value}
                                theme={presentationTheme}
                                pointerEvents="none"
                                style={styles.progress}
                            />
                        ) : undefined}
                        mode="info"
                        showChevron={false}
                        accessibilityLabel={presentation.accessibilityLabel}
                    />
                    <ProgressChecklist
                        steps={presentation.checklistSteps}
                        testIDPrefix="plugin-transcript-activity-checklist-step"
                        showStepMessages={false}
                    />
                    {props.activity.actions.map((action) => (
                        <Item
                            key={`${action.pluginId}:${action.localId}`}
                            testID={`plugin-transcript-activity-action:${action.localId}`}
                            title={action.label ?? action.localId}
                            onPress={() => props.onOpenAction({
                                pluginId: action.pluginId,
                                localId: action.localId,
                            })}
                            showChevron={false}
                            accessibilityRole="button"
                            accessibilityLabel={action.label ?? action.localId}
                        />
                    ))}
                    {canDismiss ? (
                        <Item
                            testID="plugin-transcript-activity-dismiss"
                            title={t('session.pendingMessages.actions.dismiss')}
                            onPress={() => props.onDismiss(props.activity.identityKey)}
                            showChevron={false}
                            accessibilityRole="button"
                            accessibilityLabel={t('session.pendingMessages.actions.dismiss')}
                        />
                    ) : null}
                </ItemGroup>
            </View>
        );
    },
);
