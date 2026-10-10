import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import {
    filterSelectionListSections,
    renderSelectionListAccessory,
    type SelectionListOption,
    type SelectionListSection,
} from '@/components/ui/selectionList';
import { VirtualizedList, type VirtualizedListRef } from '@/components/ui/lists/virtualized';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { ProviderModelManagerSection } from './ProviderModelManager';
import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { t } from '@/text';

/**
 * How a page hosts the model list: the page's own content above and below the Models section, and
 * what the section says. The list is one of the page's sections, so the page scrolls as one.
 */
export type ProviderModelManagerPageHost = Readonly<{
    /** The page above the Models section (context bar, header, earlier sections). */
    header: React.ReactElement;
    /** The page below the Models section. */
    footer?: React.ReactElement | null;
    title: string;
    description?: string;
    /** Rows that lead the section's sheet: a problem with its recovery, adding models. */
    leadingRows?: React.ReactNode;
    /** Replaces the model rows while the catalog cannot list them yet (first load, failure). */
    contentState?: React.ReactNode;
    /** The one fact under the list ("3 of 312 shown in model pickers"). */
    summary?: string | null;
    /** Scroll the Models section to the top once, when the page opens on it. */
    revealOnMount?: boolean;
    /** Each new value scrolls the Models section to the top, as a row that leads to it asks. */
    revealRequest?: number;
    testID?: string;
}>;

type PageRow = Readonly<{ key: string; render: () => React.ReactElement }>;

/**
 * Rows per virtualized segment. A segment is one continuous piece of the section's sheet, so a
 * catalog of thousands of models mounts only the segments near the viewport.
 */
export const MODEL_ROWS_PER_SEGMENT = 16;

export function ProviderModelManagerPage(props: Readonly<{
    host: ProviderModelManagerPageHost;
    sections: readonly ProviderModelManagerSection[];
    modelCount: number;
    actions: React.ReactNode;
    /** One sheet per section, led by its source's header (Agent → Models). */
    grouped?: boolean;
    onShowAll?: () => void;
    onHideAll?: () => void;
    onResetVisibility?: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const listRef = React.useRef<VirtualizedListRef>(null);
    const [query, setQuery] = React.useState('');
    const { host } = props;

    const filteredSections = React.useMemo((): readonly SelectionListSection[] => filterSelectionListSections(
        props.sections.map((section) => ({ kind: 'static' as const, ...section })),
        query,
    ).flatMap((section) => section.kind === 'static' ? [section] : []), [props.sections, query]);
    const options = React.useMemo(
        (): readonly SelectionListOption[] => filteredSections.flatMap((section) => section.options),
        [filteredSections],
    );
    const grouped = props.grouped === true;

    const menuActions = React.useMemo((): PageHeaderMenuAction[] => [
        ...(props.onHideAll ? [{
            id: 'hideAll',
            testID: 'provider-model-manager.hide-all',
            title: t('settingsProviders.models.hideAll'),
            onSelect: props.onHideAll,
        }] : []),
        ...(props.onResetVisibility ? [{
            id: 'reset',
            testID: 'provider-model-manager.reset',
            title: t('settingsProviders.models.resetVisibility'),
            onSelect: props.onResetVisibility,
        }] : []),
    ], [props.onHideAll, props.onResetVisibility]);

    const listing = !host.contentState;
    const hasSummary = listing && Boolean(host.summary || props.onShowAll || menuActions.length > 0);
    const emptyTitle = query.trim() ? t('common.noMatches') : t('settingsProviders.models.empty');

    // The model rows keep their segment objects while anything else on the page changes (a typed
    // draft, a pending action), so the recycler re-renders only the segments whose rows changed.
    const modelSegments = React.useMemo((): readonly PageRow[] => {
        if (!listing) return [];
        if (options.length === 0) {
            return [{
                key: 'models:empty',
                render: () => (
                    <ItemGroup virtualizedSegment={{ first: grouped, last: grouped || !hasSummary }}>
                        <Item testID="provider-model-manager.empty" mode="info" title={emptyTitle} showChevron={false} />
                    </ItemGroup>
                ),
            }];
        }
        const segments: PageRow[] = [];
        if (grouped) {
            // Each source is its own sheet: its header row, then its models in segments.
            const sourcesById = new Map(props.sections.map((section) => [section.id, section]));
            for (const section of filteredSections) {
                const source = sourcesById.get(section.id);
                segments.push({
                    key: `models:source:${section.id}`,
                    render: () => (
                        <ItemGroup virtualizedSegment={{ first: true, last: false }}>
                            <Item
                                testID={`provider-model-manager.source:${section.id}`}
                                title={section.title ?? ''}
                                subtitle={source?.description}
                                subtitleLines={0}
                                showChevron={false}
                                rightElement={source?.headerAccessory ?? undefined}
                                rightElementOutsidePressable
                            />
                        </ItemGroup>
                    ),
                });
                for (let start = 0; start < section.options.length; start += MODEL_ROWS_PER_SEGMENT) {
                    const segment = section.options.slice(start, start + MODEL_ROWS_PER_SEGMENT);
                    const last = start + MODEL_ROWS_PER_SEGMENT >= section.options.length;
                    segments.push({
                        key: `models:rows:${section.id}:${segment[0]!.id}`,
                        render: () => (
                            <ItemGroup virtualizedSegment={{ first: false, last }}>
                                {segment.map((option) => <ProviderModelPageRow key={option.id} option={option} />)}
                            </ItemGroup>
                        ),
                    });
                }
            }
            return segments;
        }
        for (let start = 0; start < options.length; start += MODEL_ROWS_PER_SEGMENT) {
            const segment = options.slice(start, start + MODEL_ROWS_PER_SEGMENT);
            const last = !hasSummary && start + MODEL_ROWS_PER_SEGMENT >= options.length;
            segments.push({
                key: `models:rows:${segment[0]!.id}`,
                render: () => (
                    <ItemGroup virtualizedSegment={{ first: false, last }}>
                        {segment.map((option) => <ProviderModelPageRow key={option.id} option={option} />)}
                    </ItemGroup>
                ),
            });
        }
        return segments;
    }, [emptyTitle, filteredSections, grouped, hasSummary, listing, options, props.sections]);

    const rows = React.useMemo((): readonly PageRow[] => {
        const controls: PageRow = {
            key: 'models:controls',
            render: () => (
                <ItemGroup
                    title={host.title}
                    description={host.description}
                    // Grouped by source, the controls are their own sheet above the source sheets.
                    virtualizedSegment={{ first: true, last: grouped }}
                >
                    {host.leadingRows}
                    <SectionContentRow>
                        <View style={styles.controls}>
                            <CompactSearchField
                                testID="provider-model-manager.filter"
                                value={query}
                                onChangeText={setQuery}
                                placeholder={props.modelCount > 0
                                    ? t('settingsProvidersCollection.modelsFilter', { count: props.modelCount })
                                    : t('modelPickerOverlay.searchPlaceholder')}
                                style={styles.filter}
                            />
                            {props.actions}
                        </View>
                    </SectionContentRow>
                </ItemGroup>
            ),
        };
        if (!listing) {
            return [controls, {
                key: 'models:state',
                render: () => (
                    <ItemGroup virtualizedSegment={{ first: grouped, last: true }}>{host.contentState}</ItemGroup>
                ),
            }];
        }
        if (!hasSummary) return [controls, ...modelSegments];
        return [controls, ...modelSegments, {
            key: 'models:summary',
            render: () => (
                <ItemGroup virtualizedSegment={{ first: grouped, last: true }}>
                    <SectionContentRow>
                        <View style={styles.summary}>
                            <Text
                                testID="provider-model-manager.summary"
                                style={[styles.summaryText, { color: theme.colors.text.secondary }]}
                            >
                                {host.summary ?? ''}
                            </Text>
                            {props.onShowAll ? (
                                <RoundButton
                                    testID="provider-model-manager.show-all"
                                    size="small"
                                    display="secondary"
                                    title={t('settingsProviders.models.showAll')}
                                    onPress={props.onShowAll}
                                />
                            ) : null}
                            {menuActions.length > 0 ? (
                                <PageHeaderMenu testID="provider-model-manager.menu" actions={menuActions} />
                            ) : null}
                        </View>
                    </SectionContentRow>
                </ItemGroup>
            ),
        }];
    }, [grouped, hasSummary, host.contentState, host.description, host.leadingRows, host.summary, host.title, listing, menuActions, modelSegments, props.actions, props.modelCount, props.onShowAll, query, theme.colors.text.secondary]);

    const revealOnMount = host.revealOnMount === true;
    React.useEffect(() => {
        if (!revealOnMount) return;
        // Let the header above the section lay out first, as search reveals do.
        const timer = setTimeout(() => {
            void listRef.current?.scrollToIndex({ index: 0, animated: false, viewPosition: 0 });
        }, 250);
        return () => clearTimeout(timer);
    }, [revealOnMount]);
    const revealRequest = host.revealRequest ?? 0;
    // Read at reveal time: only a new request moves the page, never a changed motion preference.
    const reducedMotionRef = React.useRef(false);
    reducedMotionRef.current = useReducedMotionPreference();
    React.useEffect(() => {
        if (revealRequest === 0) return;
        // The page is already laid out: move to the section the way a scroll would.
        void listRef.current?.scrollToIndex({ index: 0, animated: !reducedMotionRef.current, viewPosition: 0 });
    }, [revealRequest]);

    const renderRow = React.useCallback(({ item }: Readonly<{ item: PageRow }>) => item.render(), []);

    return (
        <ListPresentationProvider value="page">
            <VirtualizedList
                ref={listRef}
                testID={host.testID}
                data={rows}
                keyExtractor={(item) => item.key}
                renderItem={renderRow}
                ListHeaderComponent={host.header}
                ListFooterComponent={host.footer ?? null}
                // A plain object: the web recycler assigns this style directly to its scroll element.
                style={{
                    flex: 1,
                    backgroundColor: theme.colors.surface.base,
                    ...(Platform.OS === 'web' ? { minHeight: 0 } : {}),
                }}
                contentContainerStyle={{ paddingBottom: BASE_CONTENT_PADDING_BOTTOM + bottomChromeHeight }}
                keyboardShouldPersistTaps="handled"
                backendPreference="auto"
                initialNumToRender={4}
                maxToRenderPerBatch={4}
                windowSize={7}
                estimatedItemSize={MODEL_ROWS_PER_SEGMENT * 48}
            />
        </ListPresentationProvider>
    );
}

/** Matches the page list's bottom padding (`ItemList`). */
const BASE_CONTENT_PADDING_BOTTOM = Platform.select({ ios: 34, default: 16 }) ?? 16;

/** One model as a page row: its name, what distinguishes it, and its visibility switch. */
const ProviderModelPageRow = React.memo(function ProviderModelPageRow(props: Readonly<{
    option: SelectionListOption;
    showDivider?: boolean;
}>) {
    const { option } = props;
    return (
        <Item
            testID={`provider-model-manager.row:${option.id}`}
            title={option.label}
            subtitle={option.subtitle}
            accessibilityLabel={option.accessibilityLabel}
            disabled={option.disabled}
            density="compact"
            showDivider={props.showDivider}
            showChevron={false}
            rightElement={renderSelectionListAccessory(option.rightAccessory)}
            rightElementOutsidePressable
            onPress={option.disabled ? undefined : option.onSelect}
        />
    );
});

const styles = StyleSheet.create(() => ({
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    filter: {
        flex: 1,
        minWidth: 0,
    },
    summary: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
    },
    summaryText: {
        ...Typography.default('regular'),
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        fontVariant: ['tabular-nums'],
    },
}));
