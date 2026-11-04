import React from 'react';
import { Platform, type TextStyle } from 'react-native';
import {
    HappierSelectionTiles,
    resolveHappierSelectionTileText,
    type HappierSelectionTileTextRole,
    type HappierSelectionTilesColors,
    type HappierSelectionTilesGlyphRenderer,
    type HappierSelectionTilesTextRenderer,
    type HappierSelectionTileFooterRenderer,
    type HappierActionSelectionTilesProps,
} from '@happier-dev/plugin-ui/presentation';
import { HappierUiTypographyProvider } from '@happier-dev/plugin-ui/environment';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { projectPluginUiHostPalette, projectPluginUiTheme, readPluginUiHostTypography } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { useItemDensityInputs } from '@/components/ui/lists/useResolvedItemDensity';
import { resolvePageRowDensityInput, resolvePageRowMetrics } from '@/components/ui/lists/pageRowMetrics';

// RNW defaults to break-word; option names and captions wrap at normal word boundaries instead.
const WEB_VISUAL_TEXT_WRAPPING: TextStyle & { overflowWrap: 'normal'; wordBreak: 'normal' } = {
    overflowWrap: 'normal',
    wordBreak: 'normal',
};

/**
 * Happier core's adapter for the shared tile owner (`HappierSelectionTiles` in
 * `@happier-dev/plugin-ui/presentation`), which owns selection, semantics, the
 * keyboard, layout and the selection ring. This adapter supplies only what is
 * app-private: the Unistyles colours, the Unistyles typography through the app
 * `Text` (so the in-app font scale applies) and the app icon pack.
 */
export interface SelectionTile<T extends string> {
    id: T;
    title: string;
    subtitle?: string;
    icon?: IconName;
    /**
     * An identity mark drawn in the icon's place (a service's logo) when the option is a thing with an
     * identity of its own. Plain, like every mark: nothing behind it.
     */
    mark?: React.ReactNode;
    disabled?: boolean;
    badge?: string;
    /**
     * A small rendering of what this option looks like (visual tiles or compact card rows). Pass the real component at
     * static props — not a drawn replica — so the preview cannot drift from the product.
     */
    preview?: React.ReactNode;
    /** Visual tiles: `dashed` draws the preview's edge dashed, for an empty slot that adds something (Your picture…). */
    previewEdge?: 'solid' | 'dashed';
    /** Overrides the `testIdPrefix:id` test id of this tile. */
    testID?: string;
}

export type SelectionTileFooterRenderer<T extends string> = (params: Readonly<{
    option: SelectionTile<T>;
    selected: boolean;
    disabled: boolean;
}>) => React.ReactNode;

type SelectionTilesBaseProps<T extends string> = {
    options: Array<SelectionTile<T>>;
    /**
     * `card` (default): text tiles with an icon, title and subtitle. `visual`: a picker for options that
     * change what you see — each tile is the option's preview with its label underneath.
     */
    variant?: 'card' | 'visual';
    /**
     * Visual variant only. `natural` (default) keeps each tile at its natural size, left-aligned under
     * the row label. `fill` shares the full width equally, for a picker that is the section's main
     * decision (theme mode).
     */
    tileSizing?: 'natural' | 'fill';
    /** Visual `fill` only: the preview's width ÷ height (a picture or swatch picker's own proportions). */
    previewAspectRatio?: number;
    /** Visual only: `hidden` drops the captions of previews that speak for themselves; tiles keep their names. */
    labels?: 'shown' | 'hidden';
    /** Visual only: lines a caption may take before it ellipsizes (default 2); the tile announces its whole name. */
    labelLines?: number;
    /** The group's accessible name (the setting it chooses). */
    accessibilityLabel?: string;
    testIdPrefix?: string;
    density?: 'regular' | 'compact';
    minimumColumns?: number;
    maximumColumns?: number;
    /** Card variant: the narrowest tile before the grid drops a column. */
    minimumTileWidth?: number;
    /** Card variant: description lines before it ellipsizes (default 4); the tile announces all of it. */
    subtitleLines?: number;
    /** Card variant: `sheet` draws the options as cells of the section sheet they sit on, not as separate tiles. */
    surface?: 'tiles' | 'sheet';
    renderOptionFooter?: SelectionTileFooterRenderer<T>;
};

type SingleSelectionTilesProps<T extends string> = SelectionTilesBaseProps<T> & {
    selectionMode?: 'single';
    value: T | null;
    onChange: (next: T | null) => void;
};

type MultipleSelectionTilesProps<T extends string> = SelectionTilesBaseProps<T> & {
    selectionMode: 'multiple';
    value: readonly T[];
    onChange: (next: T[]) => void;
};

/**
 * `action`: tiles that each start an operation (add a device, open a flow). They are buttons, not a
 * choice: no value, no selected state. Each tile shows its icon, title and a one-line description.
 */
type ActionSelectionTilesProps<T extends string> = {
    variant: 'action';
    options: Array<SelectionTile<T>>;
    onPress: (id: T) => void;
    /** Action tiles hold no choice; declared so `selectionMode` keeps discriminating the choice variants. */
    selectionMode?: undefined;
    value?: undefined;
    onChange?: undefined;
    /** The group's accessible name. */
    accessibilityLabel?: string;
    testIdPrefix?: string;
    /** A tile that carries its own state and operation (a provisioner card): status and its button. */
    renderOptionFooter?: SelectionTileFooterRenderer<T>;
};

export type SelectionTilesProps<T extends string> =
    | SingleSelectionTilesProps<T>
    | MultipleSelectionTilesProps<T>
    | ActionSelectionTilesProps<T>;

export function SelectionTiles<T extends string>(props: SelectionTilesProps<T>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const colors = React.useMemo((): HappierSelectionTilesColors => ({
        tileBackground: theme.colors.surface.base,
        tileBorder: theme.colors.border.default,
        // DESIGN.md: borders, dividers and selection are ink, never the focus blue.
        selection: theme.colors.text.primary,
        glyph: theme.colors.text.secondary,
        ring: theme.colors.text.primary,
        previewBackground: theme.colors.background.canvas,
        actionBackground: theme.colors.surface.sectionTint,
        actionBorderHovered: theme.colors.border.strong,
        // The page rows' own divider, so a sheet of choice cells reads like the rows around it.
        divider: theme.colors.border.subtle,
    }), [theme]);

    const renderText = React.useCallback<HappierSelectionTilesTextRenderer>(({ role, text, selected, compact, numberOfLines }) => (
        <Text style={[
            textStyle(styles, role, selected, compact),
            // Tile text wraps at word boundaries and is never auto-hyphenated ("ac-count"); RNW's break-word
            // still splits a single word only when it is wider than the whole text column.
            Platform.OS === 'web' && (role === 'visualLabel' || role === 'visualSublabel') ? WEB_VISUAL_TEXT_WRAPPING : null,
        ]} numberOfLines={numberOfLines}>{text}</Text>
    ), [styles]);

    const options = props.options;
    const renderGlyph = React.useCallback<HappierSelectionTilesGlyphRenderer<IconName>>(({ glyph, size, color }) => (
        <Icon name={glyph.kind === 'icon' ? glyph.name : 'check'} size={size} color={color} />
    ), []);
    const footer = props.renderOptionFooter;
    const renderOptionFooter = React.useCallback<HappierSelectionTileFooterRenderer<T, IconName>>((params) => {
        const option = props.options.find((candidate) => candidate.id === params.option.id);
        return option && footer ? footer({ ...params, option }) : null;
    }, [props.options, footer]);

    const listPresentation = useListPresentation();
    const pageTheme = React.useMemo(() => props.variant === 'action' ? projectPluginUiTheme(theme) : undefined, [props.variant, theme]);
    const pageColors = React.useMemo(() => props.variant === 'action' ? projectPluginUiHostPalette(theme) : undefined, [props.variant, theme]);
    if (props.variant === 'action') {
        return <AppActionSelectionTiles {...props} options={options} colors={colors} renderText={renderText} renderGlyph={renderGlyph}
            renderOptionFooter={footer ? renderOptionFooter : undefined} listPresentation={listPresentation} theme={pageTheme} pageColors={pageColors} />;
    }
    return <HappierSelectionTiles {...props} options={options} colors={colors} renderText={renderText} renderGlyph={renderGlyph} renderOptionFooter={footer ? renderOptionFooter : undefined} />;
}

/** Bind app-owned preferences to the shared action owner without another layout decision. */
function AppActionSelectionTiles<T extends string>(props: HappierActionSelectionTilesProps<T, IconName>) {
    const uiFontScale = useLocalSetting('uiFontScale');
    const density = useItemDensityInputs();
    const pageDensity = resolvePageRowDensityInput({ preferred: density.preferred, requested: density.resolved, requestedExplicitly: density.requested });
    const pageRowMetrics = resolvePageRowMetrics({ ...pageDensity });
    return (
        <HappierUiTypographyProvider typography={readPluginUiHostTypography()}>
            <HappierSelectionTiles {...props} pageRowMetrics={pageRowMetrics} textScale={Platform.OS === 'web' ? 1 : uiFontScale} />
        </HappierUiTypographyProvider>
    );
}

function textStyle(
    styles: typeof stylesheet,
    role: HappierSelectionTileTextRole,
    selected: boolean,
    compact: boolean,
) {
    switch (role) {
        case 'cardTitle': return [styles.title, compact ? styles.titleCompact : null];
        case 'cardSubtitle': return [styles.subtitle, compact ? styles.subtitleCompact : null];
        case 'badge': return styles.badgeText;
        case 'visualLabel': return [styles.visualLabel, selected ? styles.visualLabelSelected : null];
        case 'visualSublabel': return styles.visualSublabel;
        case 'actionTitle': return styles.actionTitle;
        case 'actionSubtitle': return styles.actionSubtitle;
    }
}

// Each tile text slot is a role of the shared type scale (`resolveHappierSelectionTileText`, which the
// plugin tiles draw with too); this adapter adds Happier's face per weight and its colours.
function tileVariant(slot: HappierSelectionTileTextRole, state?: Readonly<{ selected?: boolean; compact?: boolean }>) {
    const { role, emphasis } = resolveHappierSelectionTileText(slot, state);
    return Typography.variant(role, emphasis);
}

const stylesheet = StyleSheet.create((theme) => ({
    actionTitle: {
        ...tileVariant('actionTitle'),
        color: theme.colors.text.primary,
    },
    actionSubtitle: {
        ...tileVariant('actionSubtitle'),
        color: theme.colors.text.secondary,
    },
    visualLabel: {
        ...tileVariant('visualLabel'),
        textAlign: 'center',
        color: theme.colors.text.secondary,
    },
    visualLabelSelected: {
        ...tileVariant('visualLabel', { selected: true }),
        color: theme.colors.text.primary,
    },
    visualSublabel: {
        ...tileVariant('visualSublabel'),
        textAlign: 'center',
        color: theme.colors.text.tertiary,
        marginTop: -4,
    },
    title: {
        ...tileVariant('cardTitle'),
        color: theme.colors.text.primary,
    },
    titleCompact: {
        ...tileVariant('cardTitle', { compact: true }),
    },
    subtitle: {
        ...tileVariant('cardSubtitle'),
        color: theme.colors.text.secondary,
    },
    subtitleCompact: {
        ...tileVariant('cardSubtitle', { compact: true }),
        marginTop: theme.space.s2,
    },
    badgeText: {
        ...tileVariant('badge'),
        color: theme.colors.text.secondary,
    },
}));
