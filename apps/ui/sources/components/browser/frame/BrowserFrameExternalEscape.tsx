import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

/** Drawn height of the pill: 8pt padding on each side around a ~14pt label line box. */
const ESCAPE_DRAWN_HEIGHT_PX = 30;

const stylesheet = StyleSheet.create((theme) => ({
    escape: {
        position: 'absolute',
        top: 12,
        right: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    escapeHovered: {
        backgroundColor: theme.colors.surface.selected,
    },
    escapePressed: {
        backgroundColor: theme.colors.surface.pressed,
    },
    escapeFocused: {
        borderColor: theme.colors.border.focus,
    },
    label: {
        // `Typography.pillLabel()` rather than a bare `fontWeight:'600'`: a named Inter face ignores
        // `fontWeight`, so the old declaration rendered regular everywhere the app is not on an
        // Apple system stack — the emphasis simply did not exist on Android.
        ...Typography.pillLabel(),
        color: theme.colors.text.secondary,
    },
}));

/**
 * The always-present "open in your browser" escape rendered OVER the web iframe surface.
 *
 * Cross-origin framability is not reliably detectable from the parent document: a site that
 * refuses embedding via `X-Frame-Options`/CSP `frame-ancestors` can still fire the iframe's
 * `onLoad` against a blank document, so the load-vs-timeout heuristic
 * ({@link useWebIframeFramability}) can land on a false `framable` verdict and show a blank frame.
 * This escape is therefore ALWAYS present — never gated on the verdict — so the user can ALWAYS
 * open the page in their system browser. The full {@link BrowserFrameNonFramable} fallback still
 * owns the definitively-detected `onError`/timeout case. Native and desktop-Wry surfaces do not
 * embed via an iframe (no `X-Frame-Options` restriction) and never render this escape.
 *
 * It is a {@link HappierPressable} — the shared press owner every other button in the app uses — so
 * it has pressed, hover and focus-visible states. As a bare `Pressable` it was the only control on
 * the surface that gave no feedback at all when you pointed at it.
 */
export function BrowserFrameExternalEscape(props: Readonly<{
    testID: string;
    onOpenInSystemBrowser: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            testID={`${props.testID}-external-escape`}
            accessibilityRole="button"
            accessibilityLabel={t('browserShell.nonFramable.openInSystemBrowser')}
            onPress={props.onOpenInSystemBrowser}
            // The drawn pill is ~30pt tall; this lifts the touch target to the platform floor on
            // iOS/Android. react-native-web ignores `hitSlop`, but there the pill is already well
            // past SC 2.5.8's 24 CSS px on both axes.
            hitSlop={Math.max(0, Math.round((resolveMinimumInteractiveTargetSize(Platform.OS) - ESCAPE_DRAWN_HEIGHT_PX) / 2))}
            style={(state) => [
                stylesheet.escape,
                state.hovered ? stylesheet.escapeHovered : null,
                state.pressed ? stylesheet.escapePressed : null,
                state.focused ? stylesheet.escapeFocused : null,
            ]}
        >
            <Icon name="arrow-square-out" size={14} color={theme.colors.text.secondary} />
            <Text style={stylesheet.label}>{t('browserShell.nonFramable.openInSystemBrowser')}</Text>
        </HappierPressable>
    );
}
