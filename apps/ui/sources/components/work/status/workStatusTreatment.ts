import { StyleSheet } from 'react-native-unistyles';
import {
    resolveHappierWorkStatusGlyphColor,
    resolveHappierWorkStatusSurfaceStyle,
    resolveHappierWorkStatusWordColor,
    type HappierWorkColors,
    type HappierWorkStatusColors,
} from '@happier-dev/plugin-ui/presentation';

import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';
import { resolveAttentionStateColors } from '@/components/ui/status/StatusPill';

import type { WorkStatusTone } from './resolveWorkStatusTone';

/**
 * Happier core's binding of the shared Work status treatment (`@happier-dev/plugin-ui/presentation`,
 * the one owner plugin authors use too): the app's Work colours and the treatment (INT §5.3, R-11)
 * as Unistyles entries. Kept free of components so every status consumer can import it cheaply; the
 * Work theme and text host for the shared components are bound in `components/work/map/WorkMapView`.
 *
 * The treatment's rule — healthy work is neutral; work that needs the person or is in trouble gets a
 * soft full ring, a faint tint and its state word in the tone, never a coloured left edge — lives in
 * `resolveHappierWorkStatus*`. The map's node cards, the transcript's worker cards, Boards cards and
 * every row's state word draw from here, so a tone looks the same on every surface.
 */

const hostWorkColors = new WeakMap<Theme, HappierWorkColors>();

/**
 * The exact colour roles the shared Work primitives (status treatment, Work sections and rows, the
 * work map) draw with in Happier core: the state hues with their own tints and rings, the inset
 * ground, the pane hairline. A plugin surface derives the same roles from its theme snapshot
 * (`resolveHappierWorkTheme`). Memoized per resolved theme object.
 */
export function projectWorkColors(theme: Theme): HappierWorkColors {
    const existing = hostWorkColors.get(theme);
    if (existing) return existing;
    const colors = theme.colors;
    const projected: HappierWorkColors = Object.freeze({
        text: colors.text.primary,
        secondaryText: colors.text.secondary,
        mutedText: colors.text.tertiary,
        surface: colors.surface.base,
        inset: colors.surface.inset,
        border: colors.border.default,
        sectionRule: colors.border.subtle,
        hover: colors.surface.pressedOverlay,
        selected: colors.surface.selected,
        focus: colors.border.focus,
        attention: resolveAttentionStateColors(colors.state),
        danger: colors.state.danger,
    });
    hostWorkColors.set(theme, projected);
    return projected;
}

// Each entry reads `theme` itself: Unistyles' compiler attributes the theme dependency per style key,
// so a value hoisted above the returned object would not follow a theme change.
const styles = StyleSheet.create((theme) => ({
    wordNeutral: { color: theme.colors.text.secondary },
    surfaceAttention: resolveHappierWorkStatusSurfaceStyle('attention', projectWorkColors(theme)),
    surfaceDanger: resolveHappierWorkStatusSurfaceStyle('danger', projectWorkColors(theme)),
    wordAttention: {
        ...Typography.default('semiBold'),
        color: resolveHappierWorkStatusWordColor('attention', projectWorkColors(theme)),
    },
    wordDanger: {
        ...Typography.default('semiBold'),
        color: resolveHappierWorkStatusWordColor('danger', projectWorkColors(theme)),
    },
}));

/** The ring and tint for a card or node in this tone; `null` keeps healthy work neutral. */
export function workStatusSurfaceStyle(tone: WorkStatusTone) {
    if (tone === 'attention') return styles.surfaceAttention;
    if (tone === 'danger') return styles.surfaceDanger;
    return null;
}

type ToneColors = Readonly<{
    text: Readonly<{ secondary: string }>;
    state: Parameters<typeof resolveAttentionStateColors>[0] & Readonly<{ danger: HappierWorkStatusColors['danger'] }>;
}>;

/** A state glyph's colour in this tone (an icon has no text style): quiet secondary ink while healthy. */
export function workStatusGlyphColor(colors: ToneColors, tone: WorkStatusTone): string {
    return resolveHappierWorkStatusGlyphColor(tone, {
        secondaryText: colors.text.secondary,
        attention: resolveAttentionStateColors(colors.state),
        danger: colors.state.danger,
    });
}

/** Explicit quiet ink also works for standalone/custom subtitle text in either theme. */
export function workStatusWordStyle(tone: WorkStatusTone) {
    if (tone === 'attention') return styles.wordAttention;
    if (tone === 'danger') return styles.wordDanger;
    return styles.wordNeutral;
}
