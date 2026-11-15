import * as React from 'react';
import { ScrollView, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createWeeklyStorageReviewWorkflowSeed } from '@/components/automations/storage/weeklyStorageReviewTemplate';
import { storeWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';

import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getPreferredLanguage, t } from '@/text';
import { formatRelativeTimeOrAbsolute } from '@/utils/time/formatShortRelativeTime';

import type { HomeComposerSuggestion, HomeComposerSuggestionSince } from './homeComposerSuggestions';
import { useHomeComposerSuggestions } from './useHomeComposerSuggestions';
import { MACHINE_RESOURCE_SUGGESTION_ICON } from '@/components/machines/resources/ask/machineResourceSuggestions';

const SUGGESTION_COLUMNS = 3;
/** The shared action tiles' gap (`HappierSelectionTiles`). */
const SUGGESTION_GAP_PX = 10;
/** Three action tiles at their 180 px minimum plus two gaps; narrower columns use a swipe row. */
const SUGGESTION_GRID_MIN_WIDTH_PX = 560;
/** The phone reference leaves a glimpse of the next suggestion instead of consuming the fold. */
const SUGGESTION_PHONE_TILE_WIDTH_PX = 236;

export type HomeComposerSuggestionFill = Readonly<{
    prompt: string;
    placement: HomeComposerSuggestion['fill']['placement'] | null;
}>;

function formatSinceDay(since: HomeComposerSuggestionSince): string {
    const locale = getPreferredLanguage();
    if (since.kind === 'yesterday') {
        return formatRelativeTimeOrAbsolute(since.atMs, -1, 'day', locale);
    }
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(since.atMs));
}

function presentSuggestion(suggestion: HomeComposerSuggestion): Readonly<{ title: string; detail: string | undefined }> {
    if (suggestion.source === 'machineResources') return { title: suggestion.title, detail: suggestion.reason || undefined };
    if (suggestion.source === 'starter') {
        return {
            title: suggestion.intent === 'automation' ? t('machineStorage.tidy.weeklyReview.title') : t(`homeComposer.starter.${suggestion.intent}`),
            detail: t(suggestion.intent === 'automation' ? 'navigation.automations' : 'homeComposer.goodFirstSession'),
        };
    }
    if (suggestion.since.kind === 'today') {
        return {
            title: t('homeComposer.summarizeProjectToday', { project: suggestion.project }),
            detail: t('homeComposer.sessionsToday', { count: suggestion.sessionCount }),
        };
    }
    const day = formatSinceDay(suggestion.since);
    return {
        title: t('homeComposer.summarizeProjectSince', { project: suggestion.project, day }),
        detail: t('homeComposer.sessionsSince', { count: suggestion.sessionCount, day }),
    };
}

/**
 * Suggestions under Home's composer. Each card names its source in its detail line; pressing one
 * fills the composer (text and where to start) and never sends. First sessions have starter
 * prompts; only history-backed cards claim session counts or select a project.
 */
export const HubComposerSuggestions = React.memo(function HubComposerSuggestions(props: Readonly<{
    onFill: (fill: HomeComposerSuggestionFill) => void;
    presentation?: 'tiles' | 'links' | 'pills';
}>) {
    const suggestions = useHomeComposerSuggestions();
    return <HubComposerSuggestionList suggestions={suggestions} onFill={props.onFill} presentation={props.presentation} />;
});

/**
 * The same suggestions surface for a caller that owns its list (a machine's Ask block, AGW-11):
 * pressing fills the composer and never sends.
 */
export const HubComposerSuggestionList = React.memo(function HubComposerSuggestionList(props: Readonly<{
    suggestions: readonly HomeComposerSuggestion[];
    /** Absent when the owning composer is unavailable; suggestions remain readable, not actionable. */
    onFill?: (fill: HomeComposerSuggestionFill) => void;
    /**
     * `tiles` on the plain page. Under an atmosphere they step back so the composer stays the one hero:
     * quiet text links over Horizon and beside the planet, small glass pills over Wallpaper and Rise.
     */
    presentation?: 'tiles' | 'links' | 'pills';
}>) {
    const router = useRouter();
    const suggestions = props.suggestions;
    const presented = React.useMemo(() => suggestions.map((suggestion) => ({
        suggestion,
        ...presentSuggestion(suggestion),
    })), [suggestions]);
    const tiles = React.useMemo<SelectionTile<string>[]>(() => presented.map((entry) => ({
        id: entry.suggestion.id,
        testID: `hub-composer.suggestion.${entry.suggestion.id}`,
        icon: entry.suggestion.source === 'sessionHistory' ? 'clock-counter-clockwise'
            : entry.suggestion.source === 'machineResources' ? MACHINE_RESOURCE_SUGGESTION_ICON[entry.suggestion.kind]
            : entry.suggestion.intent === 'explain' ? 'folder'
                : entry.suggestion.intent === 'fixTest' ? 'bug' : 'timer',
        title: entry.title,
        subtitle: entry.detail,
        disabled: !props.onFill,
    })), [presented, props.onFill]);
    const onFill = props.onFill;
    const onPress = React.useCallback((id: string) => {
        const entry = presented.find((candidate) => candidate.suggestion.id === id);
        if (!entry || !onFill) return;
        if (entry.suggestion.source !== 'sessionHistory' && entry.suggestion.intent === 'automation') {
            const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed(createWeeklyStorageReviewWorkflowSeed({
                name: t('machineStorage.tidy.weeklyReview.title'),
            }));
            router.push({ pathname: '/workflows/new', params: { definitionDraftSeedId } } as never);
            return;
        }
        onFill({ prompt: entry.suggestion.source === 'machineResources' ? entry.suggestion.fill.text : entry.title,
            placement: entry.suggestion.fill.placement });
    }, [onFill, presented, router]);

    // Desktop keeps the three-column rhythm; phones keep every suggestion in one swipe row. A lone suggestion takes
    // the whole column, so its title reads on one line instead of wrapping in a third of it.
    const { width: windowWidth } = useWindowDimensions();
    const [columnWidth, setColumnWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        setColumnWidth(event.nativeEvent.layout.width);
    }, []);
    const tileCount = Math.min(tiles.length, SUGGESTION_COLUMNS);
    const availableWidth = columnWidth ?? windowWidth;
    const swipeRow = availableWidth < SUGGESTION_GRID_MIN_WIDTH_PX;
    const width = swipeRow
        ? tileCount * SUGGESTION_PHONE_TILE_WIDTH_PX + (tileCount - 1) * SUGGESTION_GAP_PX
        : tileCount === 1 ? availableWidth : (tileCount * (availableWidth - (SUGGESTION_COLUMNS - 1) * SUGGESTION_GAP_PX)) / SUGGESTION_COLUMNS
            + (tileCount - 1) * SUGGESTION_GAP_PX;

    if (tiles.length === 0) return null;
    if (props.presentation === 'links' || props.presentation === 'pills') {
        return <SuggestionLinks tiles={tiles} pills={props.presentation === 'pills'} onPress={onPress} />;
    }
    return (
        <View testID="hub-composer.suggestions" onLayout={onLayout}>
            <ScrollView
                testID="hub-composer.suggestions-scroll"
                horizontal
                scrollEnabled={swipeRow}
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                style={{ flexGrow: 0 }}
            >
                <View style={{ width }}>
                    <SelectionTiles
                        variant="action"
                        accessibilityLabel={t('homeComposer.suggestionsLabel')}
                        options={tiles}
                        onPress={onPress}
                    />
                </View>
            </ScrollView>
        </View>
    );
});

/**
 * The suggestions as one centred line of words: the detail line stays the tooltip's, not the page's. The
 * line never wraps (lab `at-links`): it keeps as many suggestions as the column holds at a readable width,
 * and those share the row, each ending in an ellipsis when it must.
 */
function SuggestionLinks(props: Readonly<{ tiles: readonly SelectionTile<string>[]; pills: boolean; onPress: (id: string) => void }>) {
    const { theme } = useUnistyles();
    const [width, setWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width), []);
    const fits = width === null ? props.tiles.length : Math.max(1, Math.floor(width / SUGGESTION_LINK_MIN_WIDTH_PX));
    return (
        <View testID="hub-composer.suggestions" accessibilityLabel={t('homeComposer.suggestionsLabel')} onLayout={onLayout}
            style={[linkStyles.row, props.pills && linkStyles.pillRow]}>
            {props.tiles.slice(0, fits).map(tile => (
                <HappierPressable key={tile.id} testID={tile.testID} accessibilityRole="button" accessibilityLabel={tile.title}
                    accessibilityHint={tile.subtitle} disabled={tile.disabled} onPress={() => props.onPress(tile.id)}
                    hitReach={props.pills ? PILL_HIT_REACH : LINK_HIT_REACH} style={linkStyles.item}>
                    {({ hovered }) => {
                        const label = (
                            <View style={[linkStyles.link, props.pills && linkStyles.pill]}>
                                {tile.icon ? <Icon name={tile.icon} size={ICON_SIZE.xs}
                                    color={props.pills ? theme.colors.text.secondary : theme.colors.text.tertiary} /> : null}
                                <Text numberOfLines={1} style={[linkStyles.text, {
                                    color: props.pills || hovered ? theme.colors.text.primary : theme.colors.text.secondary,
                                    textDecorationLine: hovered && !props.pills ? 'underline' : 'none',
                                }]}>{tile.title}</Text>
                            </View>
                        );
                        return props.pills
                            ? <GlassSurface surfaceGroup="card" style={linkStyles.pillSurface}>{label}</GlassSurface>
                            : label;
                    }}
                </HappierPressable>
            ))}
        </View>
    );
}

/** The narrowest a suggestion keeps its words readable: a 390 px phone column holds two. */
const SUGGESTION_LINK_MIN_WIDTH_PX = 160;
/** Half of each row's gaps (`linkStyles`): neighbouring suggestions' hit areas meet, never overlap. */
const PILL_HIT_REACH = 4;
const LINK_HIT_REACH = { left: 10, right: 10, top: 2, bottom: 2 } as const;

const linkStyles = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'center', columnGap: theme.space.s20 },
    item: { flexShrink: 1, minWidth: 0 },
    pillRow: { columnGap: theme.space.s8 },
    link: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, height: 30, maxWidth: 330, paddingHorizontal: theme.space.s2 },
    pill: { paddingLeft: theme.space.s10, paddingRight: theme.space.s12 },
    pillSurface: { borderRadius: 15, overflow: 'hidden' },
    text: {
        ...Typography.default(),
        ...happierPageTextMetrics('sectionDescription'),
        flexShrink: 1,
        textDecorationColor: theme.colors.border.default,
    },
}));
