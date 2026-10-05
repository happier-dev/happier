import React from 'react';
import { Platform, type TextStyle } from 'react-native';
import {
    HAPPIER_SELECTION_TILE_TEXT,
    HappierSelectionTiles,
    type HappierSelectionTileTextRole,
    type HappierSelectionTilesColors,
    type HappierSelectionTilesGlyphRenderer,
    type HappierSelectionTilesTextRenderer,
    type HappierSelectionTileFooterRenderer,
} from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

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
     * A small rendering of what this option looks like (visual variant). Pass the real component at
     * static props — not a drawn replica — so the preview cannot drift from the product.
     */
    preview?: React.ReactNode;
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
        selection: theme.colors.border.focus,
        glyph: theme.colors.text.secondary,
        ring: theme.colors.text.primary,
        previewBackground: theme.colors.background.canvas,
        actionBackground: theme.colors.surface.sectionTint,
        actionBorderHovered: theme.colors.border.strong,
    }), [theme]);

    const renderText = React.useCallback<HappierSelectionTilesTextRenderer>(({ role, text, selected, compact, numberOfLines }) => (
        <Text style={[
            textStyle(styles, role, selected, compact),
            Platform.OS === 'web' && (role === 'visualLabel' || role === 'visualSublabel') ? WEB_VISUAL_TEXT_WRAPPING : null,
        ]} numberOfLines={numberOfLines}>{text}</Text>
    ), [styles]);

    const options = props.options;
    const renderGlyph = React.useCallback<HappierSelectionTilesGlyphRenderer<IconName>>(({ glyph, size, color }) => (
        <Icon name={glyph.kind === 'icon' ? glyph.name : 'check'} size={size} color={color} />
    ), []);
    const footer = props.variant === 'action' ? undefined : props.renderOptionFooter;
    const renderOptionFooter = React.useCallback<HappierSelectionTileFooterRenderer<T, IconName>>((params) => {
        const option = props.options.find((candidate) => candidate.id === params.option.id);
        return option && footer ? footer({ ...params, option }) : null;
    }, [props.options, footer]);

    if (props.variant === 'action') {
        return <HappierSelectionTiles {...props} options={options} colors={colors} renderText={renderText} renderGlyph={renderGlyph} />;
    }
    return <HappierSelectionTiles {...props} options={options} colors={colors} renderText={renderText} renderGlyph={renderGlyph} renderOptionFooter={footer ? renderOptionFooter : undefined} />;
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

// The tiles' type scale is the shared owner's (`HAPPIER_SELECTION_TILE_TEXT`, which the plugin tiles
// draw with too); this adapter adds Happier's face per weight and its colours.
const TILE_TEXT = HAPPIER_SELECTION_TILE_TEXT;
function tileMetrics(role: keyof typeof TILE_TEXT) {
    const step = TILE_TEXT[role];
    return { fontSize: step.fontSize, lineHeight: step.lineHeight };
}

const stylesheet = StyleSheet.create((theme) => ({
    actionTitle: {
        ...Typography.default(TILE_TEXT.actionTitle.weight),
        ...tileMetrics('actionTitle'),
        color: theme.colors.text.primary,
    },
    actionSubtitle: {
        ...Typography.default(TILE_TEXT.actionSubtitle.weight),
        ...tileMetrics('actionSubtitle'),
        color: theme.colors.text.secondary,
    },
    visualLabel: {
        ...Typography.default(TILE_TEXT.visualLabel.weight),
        ...tileMetrics('visualLabel'),
        textAlign: 'center',
        color: theme.colors.text.secondary,
    },
    visualLabelSelected: {
        ...Typography.default(TILE_TEXT.visualLabel.selectedWeight ?? 'medium'),
        color: theme.colors.text.primary,
    },
    visualSublabel: {
        ...Typography.default(TILE_TEXT.visualSublabel.weight),
        ...tileMetrics('visualSublabel'),
        textAlign: 'center',
        color: theme.colors.text.tertiary,
        marginTop: -4,
    },
    title: {
        ...Typography.default(TILE_TEXT.cardTitle.weight),
        fontSize: TILE_TEXT.cardTitle.fontSize,
        color: theme.colors.text.primary,
    },
    titleCompact: {
        fontSize: TILE_TEXT.cardTitle.compactFontSize ?? TILE_TEXT.cardTitle.fontSize,
    },
    subtitle: {
        ...Typography.default(TILE_TEXT.cardSubtitle.weight),
        fontSize: TILE_TEXT.cardSubtitle.fontSize,
        color: theme.colors.text.secondary,
    },
    subtitleCompact: {
        fontSize: TILE_TEXT.cardSubtitle.compactFontSize ?? TILE_TEXT.cardSubtitle.fontSize,
        marginTop: 2,
    },
    badgeText: {
        ...Typography.default(TILE_TEXT.badge.weight),
        ...tileMetrics('badge'),
        color: theme.colors.text.secondary,
    },
}));
