import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveThemeMode, useApplyThemeSelection, useToggleThemeMode } from '@/components/settings/appearance/useApplyThemeSelection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Item } from '@/components/ui/lists/Item';
import { GlassAppearanceControls } from '@/components/settings/appearance/GlassAppearanceControls';
import { Text } from '@/components/ui/text/Text';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { motionTokens } from '@/components/ui/motion';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';
import { t } from '@/text';
import { readHappierPointerModifiers, resolveHappierPointerPlatform } from '@happier-dev/plugin-ui/presentation';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';

/**
 * The same Appearance entry in the title strip and phone header. Ordinary, long and secondary
 * presses open the shared popover; modifier-click switches through the canonical theme owner.
 */
export const AppShellThemeToggle = React.memo(function AppShellThemeToggle(props: Readonly<{
    buttonSize: number;
    glyphSize: number;
    color: string;
    interactiveTargetGapPx?: number;
}>) {
    const [visible, setVisible] = useLocalSettingMutable('titleStripThemeToggleVisible');
    if (visible === false) return null;
    return <ThemeToggleButton {...props} onHide={() => setVisible(false)} />;
});

function ThemeToggleButton(props: Readonly<{
    buttonSize: number;
    glyphSize: number;
    color: string;
    interactiveTargetGapPx?: number;
    onHide: () => void;
}>) {
    const { theme } = useUnistyles();
    const toggle = useToggleThemeMode();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const dark = theme.dark;
    const label = t('settingsAppearance.glassControls.appearance');
    const openMenu = React.useCallback(() => setMenuOpen(true), []);
    const openMenuFromContext = React.useCallback((event: unknown) => {
        (event as { preventDefault?: () => void } | null)?.preventDefault?.();
        setMenuOpen((open) => !open);
    }, []);
    return (
      <>
        <View ref={anchorRef} collapsable={false}>
            <IconButton
                testID="app-shell-theme-toggle"
                variant="plain"
                size={props.buttonSize}
                minimumInteractiveTargetSize={resolveTouchTargetFloorPx() ?? undefined}
                interactiveTargetGapPx={props.interactiveTargetGapPx}
                accessibilityLabel={label}
                tooltip={label}
                tooltipPlacement="bottom"
                tooltipHidden={menuOpen}
                hasPopup="dialog"
                expanded={menuOpen}
                icon={<ThemeToggleGlyph dark={dark} size={props.glyphSize} color={props.color} />}
                onPress={event => {
                    const modifiers = readHappierPointerModifiers(event);
                    const platform = resolveHappierPointerPlatform(Platform.OS);
                    if (platform === 'macos' || platform === 'ios' ? modifiers.metaKey : modifiers.ctrlKey) return toggle();
                    else setMenuOpen(open => !open);
                }}
                onLongPress={openMenu}
                onContextMenu={openMenuFromContext}
            />
        </View>
        <Popover
            open={menuOpen}
            anchorRef={anchorRef}
            onRequestClose={() => setMenuOpen(false)}
            autoFocusOnOpen
            maxWidthCap={320}
            placement="bottom"
            portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'start' }}
        >
            {({ maxHeight }) => <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
                <AppearancePopoverContent onClose={() => setMenuOpen(false)} onHide={props.onHide} />
            </FloatingOverlay>}
        </Popover>
      </>
    );
}

/** Detailed settings subscribe only while the Appearance surface is open. */
function AppearancePopoverContent(props: Readonly<{ onClose: () => void; onHide: () => void }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const applyThemeSelection = useApplyThemeSelection();
    const [themePreference] = useLocalSettingMutable('themePreference');
    const [themeProfiles] = useLocalSettingMutable('themeProfiles');
    const openAppearance = (customize: boolean) => {
        props.onClose();
        router.push({ pathname: '/settings/appearance', params: customize ? { setting: 'appearance.glassCustomize' } : {} });
    };
    const pointerPlatform = resolveHappierPointerPlatform(Platform.OS);
    const modifier = pointerPlatform === 'macos' || pointerPlatform === 'ios' ? '⌘' : 'Ctrl';
    return <View style={{ width: 320, maxWidth: '100%' }}>
        <SegmentedChoiceItem
            title={t('settingsAppearance.theme')}
            testIDPrefix="app-shell-theme-menu"
            options={[
                { id: 'light', label: t('settingsAppearance.themeOptions.light') },
                { id: 'dark', label: t('settingsAppearance.themeOptions.dark') },
                { id: 'adaptive', label: t('settingsAppearance.themeToggle.matchSystem') },
            ]}
            value={resolveThemeMode(themePreference)}
            onChange={mode => applyThemeSelection(mode, themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE)}
        />
        <GlassAppearanceControls presentation="compact" />
        <Item testID="appearance-customize-link" title={t('settingsAppearance.glassControls.customizeLink')} onPress={() => openAppearance(true)} />
        <Item testID="appearance-more-settings" title={t('settingsAppearance.glassControls.moreSettings')} onPress={() => openAppearance(false)} />
        <Item testID="app-shell-theme-menu-hide" title={t('settingsAppearance.themeToggle.hideFromToolbar')} onPress={() => { props.onClose(); props.onHide(); }} showChevron={false} />
        <SectionContentRow showDivider={false}><Text style={{ color: theme.colors.text.secondary, fontSize: 12, lineHeight: 16 }}>{t('settingsAppearance.glassControls.shortcutHint', { modifier })}</Text></SectionContentRow>
    </View>;
}

/** The half-filled circle turns half a turn between the modes; it starts settled (nothing animates on arrival). */
function ThemeToggleGlyph(props: Readonly<{ dark: boolean; size: number; color: string }>) {
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const progress = React.useRef(new Animated.Value(props.dark ? 1 : 0)).current;
    React.useEffect(() => {
        const animation = Animated.timing(progress, {
            toValue: props.dark ? 1 : 0,
            duration: reducedMotion ? motionTokens.durationMs.instant : motionTokens.durationMs.fast,
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        });
        animation.start();
        return () => animation.stop();
    }, [progress, props.dark, reducedMotion]);
    const turn = { transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] };
    return (
        <View style={[styles.glyph, { width: props.size, height: props.size }]}>
            <Animated.View style={[styles.layer, turn]}>
                <Icon name="circle-half" weight="fill" size={props.size} color={props.color} />
            </Animated.View>
        </View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    glyph: {
        position: 'relative',
    },
    layer: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
