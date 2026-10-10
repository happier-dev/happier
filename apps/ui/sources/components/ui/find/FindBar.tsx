import {
    HappierFindBar,
    type HappierFindBarColors,
    type HappierFindBarHost,
    type HappierFindBarLabels,
    type HappierFindBarProps,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { renderThemeMaterialSurface } from '@/components/ui/glass/GlassSurface';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { isTouchPrimaryPointer, resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';
import { useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';

const GLYPHS = {
    search: 'magnifying-glass',
    previous: 'caret-up',
    next: 'caret-down',
    close: 'x',
    history: 'clock-counter-clockwise',
    offline: 'wifi-slash',
    info: 'info',
} as const satisfies Record<Parameters<HappierFindBarHost['renderGlyph']>[0], IconName>;

function CoreFindBarText(props: React.ComponentProps<HappierFindBarHost['Text']>): React.ReactElement {
    return (
        <Text
            style={[
                props.style,
                props.tabularNumbers ? Typography.tabular() : null,
                props.mono ? Typography.mono('semiBold') : null,
            ] as React.ComponentProps<typeof Text>['style']}
            numberOfLines={props.numberOfLines}
            testID={props.testID}
        >
            {props.children}
        </Text>
    );
}

function CoreFindBarInput({ ref, ...props }: React.ComponentProps<HappierFindBarHost['TextInput']>): React.ReactElement {
    return <TextInput ref={ref} {...props} style={props.style as React.ComponentProps<typeof TextInput>['style']} />;
}

const CORE_FIND_BAR_HOST: HappierFindBarHost = {
    Text: CoreFindBarText,
    TextInput: CoreFindBarInput,
    renderGlyph: (glyph, color, size) => <Icon name={GLYPHS[glyph]} size={size} color={color} />,
    renderSpinner: (color, size) => <ActivitySpinner size={size} color={color} />,
};

/** Every generic word of the bar; the surface supplies only what its field searches. */
function buildFindBarLabels(field: string): HappierFindBarLabels {
    return {
        field,
        previous: t('find.previous'),
        next: t('find.next'),
        matchCase: t('find.matchCase'),
        regex: t('find.regex'),
        regexShort: t('find.regexShort'),
        options: t('find.options'),
        close: t('find.close'),
        done: t('find.done'),
        stop: t('find.stop'),
        noMatches: t('find.noMatches'),
        noneFound: t('find.noneFound'),
        invalidPattern: t('find.invalidPattern'),
        offline: t('find.offline'),
        unsupported: t('find.unsupported'),
        count: (current, total) => t('find.count', { current, total }),
        files: (count) => t('find.files', { count }),
        soFar: t('find.soFar'),
        loaded: t('find.loaded'),
    };
}

export type FindBarProps = Omit<HappierFindBarProps, 'labels' | 'colors' | 'host' | 'reducedMotion' | 'minimumTargetSize' | 'elevation' | 'keyboardHandlers' | 'gradient' | 'renderMaterialSurface'> & Readonly<{
    /** What the field searches, already translated: `t('find.surface.chat')`, `t('find.surface.terminal', { name })`. */
    surfaceLabel: string;
}>;

/**
 * Happier core's binding of the ONE Find bar (`HappierFindBar` in `@happier-dev/plugin-ui/presentation`).
 * Every findable surface (chat, terminal, review/diff, file viewer) mounts this; it supplies only what
 * the runtime owns: app typography (font scale, tabular and mono faces), the icon pack and spinner, the
 * reduced-motion preference, the touch-target floor, the translated words and the theme's colours.
 *
 * The capsule is a floating layer: `surface.base` in light, one step up (`surface.elevated`) in dark so it
 * stands off the transcript it floats over, with the overlay cast shadow (Find lab `.fd-bar`).
 */
export function FindBar({ surfaceLabel, ...props }: FindBarProps): React.ReactElement {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const { keyboardHandlers } = useFindSurfaceRuntime();
    const labels = React.useMemo(() => buildFindBarLabels(surfaceLabel), [surfaceLabel]);
    const { surface, border, text, state, shadowLevels } = theme.colors;
    const dark = theme.dark;
    const colors = React.useMemo<HappierFindBarColors>(() => ({
        surface: dark ? surface.elevated : surface.base,
        ring: border.strong,
        field: dark ? surface.pressed : surface.elevated,
        text: text.primary,
        secondaryText: text.secondary,
        tertiaryText: text.tertiary,
        divider: border.default,
        accent: state.active.foreground,
        accentFill: state.active.background,
        danger: text.destructive,
        hover: surface.selected,
        pressed: surface.pressed,
        focus: border.focus,
    }), [border, dark, state, surface, text]);
    const elevation = React.useMemo(() => shadowLevelStyle(shadowLevels[4]), [shadowLevels]);
    const minimumTargetSize = isTouchPrimaryPointer(Platform.OS) ? resolveMinimumInteractiveTargetSize(Platform.OS) : undefined;
    return (
        <HappierFindBar
            {...props}
            keyboardHandlers={keyboardHandlers}
            labels={labels}
            colors={colors}
            elevation={elevation}
            gradient={resolveThemeSurfaceFinish(theme, 'floating')}
            renderMaterialSurface={renderThemeMaterialSurface}
            host={CORE_FIND_BAR_HOST}
            reducedMotion={reducedMotion}
            minimumTargetSize={minimumTargetSize}
        />
    );
}
