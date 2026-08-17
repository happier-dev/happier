import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { Platform, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import { HugeiconsIcon } from '@hugeicons/react-native';

import { ICON_REGISTRY, type IconName } from './iconRegistry.generated';
import { HUGE_ICON_REGISTRY, type HugeIconName } from './iconRegistryHuge.generated';
import { useIconFamily, useIconStrokeWidth } from './iconFamily';
import { resolveHappierIconSize } from '@happier-dev/plugin-ui/presentation';

export type { IconName };

/**
 * The app's only icon component.
 *
 * Before this, 451 files reached for `@expo/vector-icons` directly across four families — Ionicons,
 * Octicons, MaterialIcons, Feather — with no seam between the app and any of them. Nineteen glyph
 * concepts (`git-branch`, `terminal`, `search`, …) were drawn by TWO different families depending on
 * which file happened to import which, so the same idea rendered two ways in the same product.
 *
 * Two things this owns that a bare icon import cannot:
 *
 * 1. **Optical size.** A declared size is an em box, not the ink inside it. Glyphs that fill their
 *    box paint noticeably more area than glyphs with generous internal margins, so a row of icons at
 *    one number looks like a row at several. That correction used to live as hand-measured constants
 *    at individual call sites; it lives in {@link ICON_INK_SCALE} now, once per glyph.
 * 2. **Weight.** Phosphor expresses filled/outline as a `weight` on one icon rather than as two
 *    separate names, so the 36 places that used a filled/outline pair to mean something — settled vs
 *    actionable, urgent vs ambient — say it with a prop instead of a second glyph.
 */

export type IconWeight = 'regular' | 'fill' | 'bold' | 'light' | 'thin' | 'duotone';

/**
 * The app's icon sizes. Call sites pick a role, not a number.
 *
 * Sizes drifted badly under the old setup — the same kind of control rendered at 14, 16, 18, 20, 21
 * and 22 in different files, because every call site chose for itself. A short named scale is the
 * fix: if a size is not on it, that is a design decision worth making deliberately.
 */
export const ICON_SIZE = {
    /** Inline with small text: badges, chips, counts. */
    xs: 14,
    /** List rows, menu items, dense toolbars. */
    sm: 16,
    /** The default. Header actions, standard toolbars. */
    md: 20,
    /** Prominent single actions. */
    lg: 24,
    /** Settings rows and empty-state art. */
    xl: 29,
} as const;

export type IconProps = Readonly<{
    name: IconName;
    /** Nominal em box; prefer a value from {@link ICON_SIZE}. Ink is corrected per glyph below. */
    size?: number;
    color?: string;
    /** Defaults to `regular` (outline). `fill` is for state: selected, active, urgent. */
    weight?: IconWeight;
    /** Horizontally flips the glyph — e.g. a left-sidebar icon standing for the right sidebar. */
    mirrored?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    /** Screen-reader name. Omit for icons that only decorate labelled content. */
    accessibilityLabel?: string;
}>;

const DEFAULT_SIZE_PX = resolveHappierIconSize('medium');

/**
 * Per-glyph optical correction, as a multiplier on the requested size.
 *
 * Phosphor draws one family on one grid, so most of the correction the old multi-family setup needed
 * has simply gone away — glyphs render at 1.0 unless they measurably diverge. What remains is glyphs
 * whose INK is unusually sparse or dense for their box: three small dots read far lighter than a
 * full-bleed rectangle at the same number, so the number is not what the eye compares.
 */
const ICON_INK_SCALE: Partial<Record<IconName, number>> = {
    // Empty on purpose, and that is the headline result of the migration.
    //
    // Under four icon families this table was load-bearing: `terminal-outline` (Ionicons) and
    // `sidebar-expand` (Octicons) were drawn to different grids, so matching their declared sizes
    // produced visibly different ink and every mismatch had to be measured off a screenshot and
    // corrected by hand. Phosphor draws one family on one grid, so a row of icons at one number now
    // simply looks like one size.
    //
    // This table briefly held guesses (`dots-three` 1.2, `sidebar` 0.92). Measured in the running
    // app they were the size bug, not the fix: they rendered a nominal-20 glyph at 24 and 18 next to
    // true-20 neighbours. Anything added here must come from a measurement, not an impression.
};

/**
 * Concepts pinned to Phosphor regardless of the selected family.
 *
 * Not a fallback for a missing glyph — these are ones where Phosphor's drawing was judged better on
 * the actual surface. Keep this short: every entry is a second family loaded into the bundle and a
 * glyph that will not match its neighbours' grid.
 */
const PHOSPHOR_PINNED = new Set<IconName>([
    // HugeIcons' star is a thin, wide five-point outline that reads as a rating widget next to the
    // dense favourite rows it sits in; Phosphor's is tighter and more compact.
    'star',
]);

/**
 * The stroke, in HugeIcons' 24-unit grid, that a glyph of `size` should draw with.
 *
 * HugeIcons scales its stroke with the glyph: a fixed 2 units renders 1.33px at 16 and 2.33px at 28,
 * so the large settings-row icons came out visibly heavier than everything around them. Above the
 * app's dominant size the stroke is scaled back so the RENDERED width stops growing; at or below it
 * nothing changes, because a constant absolute stroke would make the 14px glyphs look clumsy.
 */
const HUGEICONS_STROKE_REFERENCE_SIZE_PX = ICON_SIZE.md;

function hugeStrokeUnitsForSize(units: number, size: number): number {
    if (size <= HUGEICONS_STROKE_REFERENCE_SIZE_PX) return units;
    return units * (HUGEICONS_STROKE_REFERENCE_SIZE_PX / size);
}

export const Icon = React.memo((props: IconProps) => {
    const { theme } = useUnistyles();
    const family = useIconFamily();
    const strokeWidth = useIconStrokeWidth();


    const Glyph = ICON_REGISTRY[props.name];
    const nominal = props.size ?? DEFAULT_SIZE_PX;
    const scale = ICON_INK_SCALE[props.name] ?? 1;
    const accessibilityProps = props.accessibilityLabel
        ? Platform.OS === 'web'
            ? { 'aria-label': props.accessibilityLabel, role: 'img' as const }
            : { accessibilityLabel: props.accessibilityLabel, accessible: true as const }
        : Platform.OS === 'web'
            ? { 'aria-hidden': true as const }
            : {
                accessibilityElementsHidden: true as const,
                importantForAccessibility: 'no-hide-descendants' as const,
            };

    // HugeIcons draws outline only. `fill` is a Phosphor capability, so a filled request always goes
    // there regardless of the chosen family — and so does any concept HugeIcons has no glyph for.
    const hugeGlyph = props.weight === 'fill' || PHOSPHOR_PINNED.has(props.name)
        ? undefined
        : HUGE_ICON_REGISTRY[props.name as HugeIconName];
    if (family === 'hugeicons' && hugeGlyph) {
        return (
            // `HugeiconsIcon` destructures `style` out of its props and never forwards it to the
            // underlying `Svg`, so anything a caller sets — positioning, transforms, the optical
            // nudge — silently vanishes. Carrying it on a wrapper restores the contract callers
            // already rely on from the Phosphor path.
            <View style={props.style}>
            <HugeiconsIcon
                icon={hugeGlyph}
                size={Math.round(nominal * scale)}
                color={props.color ?? theme.colors.text.secondary}
                strokeWidth={hugeStrokeUnitsForSize(strokeWidth, Math.round(nominal * scale))}
                testID={props.testID}
                {...accessibilityProps}
            />
            </View>
        );
    }

    // The registry is an allowlist, and not every name reaching it is a literal the compiler checked:
    // plugin-contributed tokens, persisted values and data-derived names all arrive as plain strings.
    // Rendering an undefined component throws inside React's reconciler and takes down the whole
    // surrounding pane — an entire panel going blank is a far worse outcome than one absent glyph, so
    // an unknown name reserves its layout box instead and says which name was missing.
    if (!Glyph) {
        if (__DEV__) {
            console.warn(`[Icon] "${props.name}" is not in the icon registry — add it to scripts/icons/mapping.json and regenerate.`);
        }
        return <View style={[{ width: nominal, height: nominal }, props.style]} testID={props.testID} />;
    }

    return (
        <Glyph
            size={Math.round(nominal * scale)}
            color={props.color ?? theme.colors.text.secondary}
            weight={props.weight ?? 'regular'}
            mirrored={props.mirrored}
            style={props.style}
            testID={props.testID}
            {...accessibilityProps}
        />
    );
});

Icon.displayName = 'Icon';
