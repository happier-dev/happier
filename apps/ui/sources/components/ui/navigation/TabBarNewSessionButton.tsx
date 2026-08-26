import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import {
    shouldForceFreshNewSessionEntryFromPressEvent,
    useResolveNewSessionOrdinaryEntryRoute,
} from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';

/**
 * The "+" capsule that sits beside the floating tab bar on the sessions surface — a second,
 * thumb-reachable way into the new-session flow while the header "+" stays where it is.
 *
 * It is a SIBLING of the bar, never a fifth tab: creating a session is not a navigation
 * destination, it must never take the active-tab highlight, and iOS 26 places its own search button
 * the same way. `FloatingTabBarSurface` stretches it to the bar's exact height, so this component
 * only has to be square (`aspectRatio`) and let `GlassPanel` paint the same material, rim and cast
 * shadow as the bar.
 */

/** Matches the bar's capsule; both clamp to a full pill at any height. */
const CAPSULE_RADIUS = 999;

const styles = StyleSheet.create({
    capsule: {
        // Height comes from the row (stretch); `aspectRatio` turns it into a circle rather than
        // hardcoding a size the tab-bar size setting would drift from. `alignSelf` rather than
        // `flex: 1`: in the row this sits in, a flex weight would let the capsule GROW horizontally
        // into the leftover space instead of staying square at the trailing edge.
        alignSelf: 'stretch',
        aspectRatio: 1,
    },
    press: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: CAPSULE_RADIUS,
    },
    pressed: {
        opacity: 0.92,
    },
});

export const TabBarNewSessionButton = React.memo(function TabBarNewSessionButton() {
    const router = useRouter();
    const resolveNewSessionOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    const { theme } = useUnistyles();
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'), Platform.OS);

    const handlePress = React.useCallback((event?: unknown) => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute({
            forceFresh: shouldForceFreshNewSessionEntryFromPressEvent(event),
        });
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveNewSessionOrdinaryEntryRoute, router]);

    return (
        <GlassPanel radius={CAPSULE_RADIUS} style={styles.capsule}>
            <Pressable
                testID="tabbar-start-new-session"
                accessibilityRole="button"
                accessibilityLabel={t('newSession.title')}
                onPress={handlePress}
                // No `hitSlop`: the capsule is the full bar height, so even the smallest tab-bar
                // size paints a target at the platform minimum, and slop here would overlap the
                // neighbouring tab's own slop across the 8pt gap.
                style={({ pressed }) => [styles.press, pressed ? styles.pressed : null]}
            >
                <Icon name="plus" size={metrics.iconSize} color={theme.colors.text.primary} />
            </Pressable>
        </GlassPanel>
    );
});
