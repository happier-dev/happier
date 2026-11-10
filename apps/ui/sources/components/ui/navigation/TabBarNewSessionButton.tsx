import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { DeferredAnchoredTooltip } from '@/components/ui/overlays/DeferredAnchoredTooltip';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { t } from '@/text';
import {
    shouldForceFreshNewSessionEntryFromPressEvent,
} from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';
import { useOpenNewSession } from '@/components/sessions/new/navigation/newSessionEntry';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { usePageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';

/**
 * The "+" capsule that sits beside the floating tab bar on the sessions surface: the phone's one,
 * thumb-reachable way into the new-session flow (the header has no "+" of its own).
 *
 * It is a SIBLING of the bar, never a fifth tab: creating a session is not a navigation
 * destination, it must never take the active-tab highlight, and iOS 26 places its own search button
 * the same way. `FloatingTabBarSurface` gives it a square cell as tall as the bar, so this component
 * only fills that cell (`GlassPanel` `frameStyle`, so the cast shadow and the glass share it) and
 * lets `GlassPanel` paint the same material, rim and cast shadow as the bar.
 *
 * `sidebar` is the same button floating at the bottom-right of the desktop sidebar's session list,
 * the sidebar's one way into a new session: a fixed circle, with a tooltip naming it and its
 * keyboard shortcut.
 */

/** The sidebar placement's circle: a comfortable pointer target that stays small over the list. */
const SIDEBAR_DIAMETER_PX = 44;
/** How far the sidebar's "+" floats in from the list's bottom-right corner. */
export const SIDEBAR_NEW_SESSION_INSET_PX = 12;
/** The height the sidebar's "+" occupies at the list's foot; anything docked there rides above it. */
export const SIDEBAR_NEW_SESSION_FOOTPRINT_PX = SIDEBAR_NEW_SESSION_INSET_PX + SIDEBAR_DIAMETER_PX;

/** Matches the bar's capsule; both clamp to a full pill at any height. */
const CAPSULE_RADIUS = 999;

const styles = StyleSheet.create({
    capsule: {
        // Fills the square cell `FloatingTabBarSurface` gives its accessory (as wide as the bar is
        // tall), so the tab-bar size setting sizes it and nothing here hardcodes a size.
        flex: 1,
    },
    press: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: CAPSULE_RADIUS,
    },
    pressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    sidebarCapsule: {
        width: SIDEBAR_DIAMETER_PX,
        height: SIDEBAR_DIAMETER_PX,
    },
});


export function useTabBarNewSessionPress() {
    const openNewSession = useOpenNewSession();
    return React.useCallback((event?: unknown) => {
        openNewSession({
            forceFresh: shouldForceFreshNewSessionEntryFromPressEvent(event),
        });
    }, [openNewSession]);
}

/**
 * The bar's "+" capsule for a main screen's own create action (`usePageCreateAction`): the same capsule as Sessions'
 * new-session "+", running whatever the page in front lends it, and an empty cell while it lends nothing.
 */
export const TabBarPageCreateButton = React.memo(function TabBarPageCreateButton() {
    const action = usePageCreateAction();
    const { theme } = useUnistyles();
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    if (!action) return <View />;
    return (
        <GlassPanel radius={CAPSULE_RADIUS} frameStyle={styles.capsule}>
            <HappierPressable
                testID={`tabbar-create:${action.testID}`}
                accessibilityLabel={action.label}
                onPress={action.onPress}
                style={(state) => [
                    styles.press,
                    state.pressed ? styles.pressed : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                <Icon name="plus" size={metrics.iconSize} color={theme.colors.text.primary} />
            </HappierPressable>
        </GlassPanel>
    );
});

export const TabBarNewSessionButton = React.memo(function TabBarNewSessionButton(props: Readonly<{
    placement?: 'tabBar' | 'sidebar';
}>) {
    const handlePress = useTabBarNewSessionPress();
    const { theme } = useUnistyles();
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    const shortcut = useKeyboardShortcutLabel('session.new');
    const sidebar = props.placement === 'sidebar';
    const label = t('newSession.title');
    const anchorRef = React.useRef<View | null>(null);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);

    const button = (
        <GlassPanel radius={CAPSULE_RADIUS} shadowLevel={sidebar ? 2 : undefined} style={sidebar ? styles.sidebarCapsule : undefined} frameStyle={sidebar ? undefined : styles.capsule}>
            <HappierPressable
                testID={sidebar ? 'sidebar-start-new-session' : 'tabbar-start-new-session'}
                accessibilityLabel={label}
                onPress={handlePress}
                onFocusChange={sidebar ? setFocused : undefined}
                // Keep this capsule's hit area out of the neighbouring tab's expanded press area.
                style={(state) => [
                    styles.press,
                    state.pressed ? styles.pressed : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                <Icon name="plus" size={sidebar ? ICON_SIZE.md : metrics.iconSize} color={theme.colors.text.primary} />
            </HappierPressable>
        </GlassPanel>
    );
    if (!sidebar) return button;
    // The sidebar's tooltip names the button and its shortcut on hover or keyboard focus (web).
    return (
        <View
            ref={anchorRef}
            collapsable={false}
            // The sidebar's "+" floats over the session list: the QA hit-area probe accepts it covering a row.
            {...(Platform.OS === 'web' ? { dataSet: { happierFloatingOverlay: 'true' } } : {})}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
        >
            {button}
            {Platform.OS === 'web' && (hovered || focused) ? (
                <DeferredAnchoredTooltip
                    activationKey={`${hovered}:${focused}`}
                    anchorRef={anchorRef}
                    placement="top"
                    label={shortcut ? `${label} · ${shortcut}` : label}
                    testID="sidebar-start-new-session-tooltip"
                />
            ) : null}
        </View>
    );
});
