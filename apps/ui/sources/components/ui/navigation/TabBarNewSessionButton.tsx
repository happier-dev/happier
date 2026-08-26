import * as React from 'react';
import { useRouter } from 'expo-router';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon } from '@/components/ui/icons/Icon';
import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import {
    shouldForceFreshNewSessionEntryFromPressEvent,
    useResolveNewSessionOrdinaryEntryRoute,
} from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';

/**
 * The "+" capsule that sits beside the floating tab bar on the sessions list — a
 * second, thumb-reachable way into the new-session flow while the header "+" stays
 * where it is.
 *
 * It is a SIBLING of the bar, never a fifth tab: creating a session is not a
 * navigation destination, it must never take the active-tab highlight, and iOS 26
 * places its own search button the same way. `FloatingTabBarSurface` stretches it to
 * the bar's exact height, so this component only has to be square (`aspectRatio`)
 * and let `GlassPanel` paint the same material, rim and cast shadow as the bar.
 */

/** Matches the bar's capsule; both clamp to a full pill at any height. */
const CAPSULE_RADIUS = 999;

const styles = StyleSheet.create({
    capsule: {
        // Height comes from the row (stretch); `aspectRatio` turns it into a circle
        // rather than hardcoding a size the tab-bar size setting would drift from.
        // `alignSelf` rather than `flex: 1`: in the row this now sits in, a flex weight
        // would let the capsule GROW horizontally into the leftover space instead of
        // staying square at the far right.
        alignSelf: 'stretch',
        aspectRatio: 1,
    },
    press: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: CAPSULE_RADIUS,
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
            <PressableSurface
                testID="tabbar-start-new-session"
                accessibilityRole="button"
                accessibilityLabel={t('newSession.title')}
                onPress={handlePress}
                // No `hitSlop`: the capsule stretches to the tab row, whose shared
                // metrics enforce the platform's minimum interactive target height.
                focusRingRadius={CAPSULE_RADIUS}
                style={styles.press}
            >
                <Icon name="plus" size={metrics.iconSize} color={theme.colors.text.primary} />
            </PressableSurface>
        </GlassPanel>
    );
});
