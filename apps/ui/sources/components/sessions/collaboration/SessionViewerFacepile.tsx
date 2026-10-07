import * as React from 'react';
import { Animated, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { Text } from '@/components/ui/text/Text';
import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SessionHumanPresenceViewer } from '@/sync/domains/session/humanPresence/sessionHumanPresenceStore';

import { formatSessionPresenceViewerNames } from './sessionPresenceNames';
import { isHappierFocusVisible } from '@happier-dev/plugin-ui/presentation';

const AVATAR_SIZE = 28;
/** One de-emphasis for retained last-known presence, shared with the Collaboration summary row. */
export const STALE_PRESENCE_OPACITY = 0.65;
const styles = StyleSheet.create((theme) => ({
    button: {
        minHeight: resolveMinimumInteractiveTargetSize(Platform.OS),
        minWidth: resolveMinimumInteractiveTargetSize(Platform.OS),
        paddingHorizontal: 8,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        borderRadius: 8, borderWidth: 1, borderColor: 'transparent',
    },
    hovered: { backgroundColor: theme.colors.surface.selected },
    overflow: { ...Typography.default('semiBold'), ...ITEM_SUBTITLE_TEXT_METRICS.cozy, color: theme.colors.text.secondary, paddingLeft: 4 },
}));

function ViewerAvatar({ viewer }: Readonly<{ viewer: SessionHumanPresenceViewer }>) {
    const reducedMotion = useReducedMotionPreference();
    const opacity = React.useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
    React.useEffect(() => {
        if (reducedMotion) { opacity.setValue(1); return; }
        const animation = Animated.timing(opacity, { toValue: 1, duration: motionTokens.durationMs.fast, useNativeDriver: true });
        animation.start();
        return () => animation.stop();
    }, [opacity, reducedMotion]);
    return <Animated.View testID="session-viewer-avatar" accessible={false} style={{ opacity }}>
        <Avatar id={viewer.account.accountId} size={AVATAR_SIZE} imageUrl={viewer.account.avatarUrl} />
    </Animated.View>;
}

export function SessionViewerFacepile({ viewers, stale, attentionLabel, onPress }: Readonly<{
    viewers: readonly SessionHumanPresenceViewer[];
    stale: boolean;
    attentionLabel?: string | null;
    onPress: () => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View | null>(null);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    if (viewers.length === 0) return null;
    // The ring colour is not perceivable to every viewer, so who is typing has to
    // reach the accessible name through the shared presence-name owner.
    const names = formatSessionPresenceViewerNames(viewers, { stale });
    const label = `${t('session.collaboration.title')}, ${t('session.collaboration.viewingNow')}, ${viewers.length}: ${names}${stale ? `. ${t('session.collaboration.stale')}` : ''}${attentionLabel ? `. ${attentionLabel}` : ''}`;
    return <Pressable
        ref={anchorRef}
        testID="session-viewer-facepile"
        onPress={onPress}
        onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
        onFocus={(event) => setFocused(isHappierFocusVisible(event?.target))} onBlur={() => setFocused(false)}
        accessibilityRole="button" accessibilityLabel={label} accessibilityHint={t('session.collaboration.open')}
        style={({ pressed }) => [styles.button, hovered && styles.hovered, focusRingStyle({ focused, color: theme.colors.border.focus }), { opacity: pressed ? motionTokens.press.opacity : stale ? STALE_PRESENCE_OPACITY : 1 }]}
    >
        <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <AvatarStack size={AVATAR_SIZE} entries={viewers.slice(0, 3).map((viewer) => ({
                key: viewer.account.accountId,
                ringColor: !stale && viewer.typing ? theme.colors.text.link : undefined,
                content: <ViewerAvatar viewer={viewer} />,
            }))} />
            {viewers.length > 3 ? <Text testID="session-viewer-overflow" style={styles.overflow}>{`+${viewers.length - 3}`}</Text> : null}
        </View>
        {Platform.OS === 'web' && (hovered || focused) ? <DeferredAnchoredTooltip anchorRef={anchorRef} activationKey={`${hovered}:${focused}`} label={t('session.collaboration.open')} /> : null}
    </Pressable>;
}
