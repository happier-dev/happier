import * as React from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_WIDGET_FRAME_METRICS, HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { WidgetFlowStep } from '@/components/widgets/flow/WidgetFlowShell';

import { WidgetSetupStep } from './WidgetSetupStep';
import type { WidgetSetup, WidgetSetupSubmitResult } from './widgetSetupModel';
import {
    filterWidgetAddSections,
    matchesWidgetAddAsk,
    resolveWidgetAddPick,
    type WidgetAddAsk,
    type WidgetAddEntry,
    type WidgetAddOutcome,
    type WidgetAddSection,
    type WidgetAddView,
} from './widgetAddModel';

/**
 * The preview box keeps one height, so a tile never resizes while its widget loads. The body is the
 * real one at its own size: its first rows show and the box clips the rest (lab dbind G).
 */
const PREVIEW_HEIGHT_PX = 96;
const BLANK_PREVIEW_HEIGHT_PX = 64;
/** A tile's inset around its preview; the preview's corner is the card's less it, so the two are concentric. */
const TILE_PADDING_PX = 6;
const CHIP_HEIGHT_PX = 30;

export type WidgetAddPanelProps = Readonly<{
    title: string;
    /** Who sees what you add ("Everyone here sees what you add"). */
    hint?: string;
    searchPlaceholder: string;
    view: WidgetAddView;
    onViewChange: (view: WidgetAddView) => void;
    sections: readonly WidgetAddSection[];
    initialOutcome?: WidgetAddOutcome;
    ask?: WidgetAddAsk;
    /** Phones: the switch takes its own full-width row under the title, and Done closes. */
    phone?: boolean;
    onRequestClose: () => void;
    /** The Set up step opened or closed (the popover widens for its inputs | preview columns). */
    onSetupOpenChange?: (open: boolean) => void;
    /** Exact Home/session identity for the step's option reads. */
    serverId?: string | null;
    sessionId?: string | null;
    testID: string;
}>;

/**
 * What became of the last pick, shown on the picked tile or row itself (never as a line that pushes
 * the gallery down): added — its count ticks and a check lands; waiting for someone's approval; or
 * refused, with the reason in the tile's own second line.
 */
type AddFeedback = Readonly<{ entryId: string; kind: 'added' | 'pending' | 'failed'; message: string }>;

function feedbackForOutcome(outcome: WidgetAddOutcome): AddFeedback {
    const { entryId, result } = outcome;
    if (!result.ok) return { entryId, kind: 'failed', message: result.message };
    return { entryId, kind: result.approvalPending ? 'pending' : 'added',
        message: result.approvalPending ? t('widgetAdd.areaApprovalPending') : t('widgetAdd.justAdded', { widget: outcome.title }) };
}

/**
 * The one Add surface for widgets (lab `cwidgets` G1, round 2): a title with who sees what you add,
 * a Gallery | List switch (the Collection's view switch), search, then the placement's sections.
 *
 * Gallery shows widgets as they are — a tile per widget with its real body at this placement's
 * data — because widgets are visual. List is the same sections, search and Added rows as menu rows,
 * denser, and mounts no preview. The panel owns no data and no write path: each pick goes to the
 * entry's own `onPick` (the placement's existing add path), and the panel stays open for another
 * unless the pick hands the focus somewhere else.
 */
export function WidgetAddPanel(props: WidgetAddPanelProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [query, setQuery] = React.useState('');
    const sections = React.useMemo(() => filterWidgetAddSections(props.sections, query), [props.sections, query]);
    const ask = props.ask && matchesWidgetAddAsk(props.ask, query) ? props.ask : null;
    const close = props.onRequestClose;
    // The one Set up step (lab dadd A): open only for a configurable pick with something missing or
    // ambiguous. Search and the chosen view stay as they were, so Back returns to the same gallery.
    const [setup, setSetup] = React.useState<Readonly<{ entryId: string; setup: WidgetSetup }> | null>(null);
    // Which way the last step change went, so the arriving step enters from the right side.
    const [direction, setDirection] = React.useState<'none' | 'forward' | 'backward'>('none');
    const [feedback, setFeedback] = React.useState<AddFeedback | null>(() => props.initialOutcome ? feedbackForOutcome(props.initialOutcome) : null);
    React.useEffect(() => {
        if (feedback) AccessibilityInfo.announceForAccessibility?.(feedback.message);
    }, [feedback]);
    const onSetupOpenChange = props.onSetupOpenChange;
    const openSetup = React.useCallback((next: Readonly<{ entryId: string; setup: WidgetSetup }> | null) => {
        setSetup(next);
        setDirection(next !== null ? 'forward' : 'backward');
        onSetupOpenChange?.(next !== null);
    }, [onSetupOpenChange]);
    const confirmAdded = React.useCallback((entry: Readonly<{ id: string; title: string }>, result: Extract<WidgetSetupSubmitResult, { ok: true }>) => {
        setFeedback(feedbackForOutcome({ entryId: entry.id, title: entry.title, result }));
    }, []);
    const refuse = React.useCallback((entryId: string, message: string) => {
        setFeedback({ entryId, kind: 'failed', message });
    }, []);
    const pick = React.useCallback((entry: WidgetAddEntry) => {
        const decision = resolveWidgetAddPick(entry);
        if (decision.kind === 'added') return;
        setFeedback(null);
        if (decision.kind === 'setup') {
            openSetup({ entryId: entry.id, setup: decision.setup });
            return;
        }
        if (decision.kind === 'submit') {
            const next = decision.setup;
            // Fully bound: no step. It goes straight through the same Action, and the tile says so.
            void next.submit(next.initial).then(
                (result) => (result.ok ? confirmAdded(entry, result) : refuse(entry.id, result.message)),
                () => refuse(entry.id, t('widgetAdd.addFailed')),
            );
            return;
        }
        const result = entry.onPick();
        if (result) {
            void result.then(
                (outcome) => (outcome.ok ? confirmAdded(entry, outcome) : refuse(entry.id, outcome.message)),
                () => refuse(entry.id, t('widgetAdd.addFailed')),
            );
        } else if (entry.closesOnPick) close();
    }, [close, confirmAdded, openSetup, refuse]);
    const pickAsk = React.useCallback(() => {
        props.ask?.onPick();
        close();
    }, [close, props.ask]);

    const tabs = React.useMemo(() => [
        { id: 'gallery' as const, label: t('widgetAdd.viewGallery') },
        { id: 'list' as const, label: t('widgetAdd.viewList') },
    ], []);
    const switcher = (
        <SegmentedTabBar
            tabs={tabs}
            activeTabId={props.view}
            onSelectTab={props.onViewChange}
            testIDPrefix={`${props.testID}.view`}
            accessibilityLabel={t('widgetAdd.viewLabel')}
            segmentSizing={props.phone ? 'equal' : 'content'}
            slidingThumb
            targetSize="platform"
        />
    );
    const nothing = sections.length === 0 && !ask;

    // The same surface carries the gallery and its one Set up step: the step pushes in from the
    // trailing edge while the surface widens around it, and Back returns along the same path.
    if (setup) {
        const entryTitle = props.sections.flatMap((section) => section.entries).find((entry) => entry.id === setup.entryId)?.title;
        return (
            <WidgetFlowStep key={`setup:${setup.entryId}`} direction={direction}>
                <WidgetSetupStep
                    setup={setup.setup}
                    phone={props.phone === true}
                    onBack={() => openSetup(null)}
                    onCancel={close}
                    onDone={(result) => {
                        openSetup(null);
                        confirmAdded({ id: setup.entryId, title: entryTitle ?? setup.setup.title }, result);
                    }}
                    {...(props.serverId ? { serverId: props.serverId } : {})}
                    {...(props.sessionId ? { sessionId: props.sessionId } : {})}
                    testID={`${props.testID}.setup`}
                />
            </WidgetFlowStep>
        );
    }

    return (
        <WidgetFlowStep key="gallery" direction={direction}>
        <View testID={props.testID} accessibilityLabel={props.title} style={styles.root}>
            <View style={styles.header}>
                <View style={styles.titleBlock}>
                    <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
                        {props.title}
                    </Text>
                    {props.hint && !props.phone ? <Text style={styles.hint} numberOfLines={1}>{props.hint}</Text> : null}
                </View>
                {props.phone ? (
                    <HappierPressable
                        testID={`${props.testID}.done`}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.done')}
                        onPress={close}
                        style={(state) => [styles.done, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    >
                        <Text style={styles.doneLabel}>{t('common.done')}</Text>
                    </HappierPressable>
                ) : switcher}
            </View>
            {props.phone ? <View style={styles.switchRow}>{switcher}</View> : null}
            <CompactSearchField
                value={query}
                onChangeText={setQuery}
                placeholder={props.searchPlaceholder}
                testID={`${props.testID}.search`}
                style={styles.search}
                {...(Platform.OS === 'web' && !props.phone ? { autoFocus: true } : {})}
            />
            {props.view === 'gallery' ? (
                <>
                    {sections.map((section) => (
                        <GallerySection key={section.id} section={section} phone={props.phone === true} onPick={pick}
                            feedback={feedback} testID={props.testID} />
                    ))}
                    {ask ? <AskTile ask={ask} onPick={pickAsk} testID={`${props.testID}.ask`} /> : null}
                </>
            ) : (
                <>
                    {sections.map((section, index) => (
                        <ActionListSection
                            key={section.id}
                            title={section.title}
                            separatorAbove={index > 0}
                            actions={section.entries.map((entry) => listRow(entry, pick, props.testID, theme.colors,
                                feedback?.entryId === entry.id ? feedback : null))}
                        />
                    ))}
                    {ask ? (
                        <ActionListSection
                            separatorAbove={sections.length > 0}
                            actions={[{
                                id: 'ask',
                                testID: `${props.testID}.ask`,
                                label: ask.title,
                                subtitle: ask.note,
                                icon: <Icon name="sparkle" size={18} color={theme.colors.text.secondary} />,
                                onPress: pickAsk,
                            }]}
                        />
                    ) : null}
                </>
            )}
            {nothing ? (
                <Text style={styles.empty} testID={`${props.testID}.noMatch`}>
                    {t('widgetAdd.noMatch', { query: query.trim() })}
                </Text>
            ) : null}
        </View>
        </WidgetFlowStep>
    );
}

function listRow(
    entry: WidgetAddEntry,
    pick: (entry: WidgetAddEntry) => void,
    testID: string,
    colors: Readonly<{ text: Readonly<{ secondary: string; tertiary: string }>; state: Readonly<{ danger: Readonly<{ foreground: string }> }> }>,
    feedback: AddFeedback | null,
): ActionListItem {
    // A pick's outcome stays on its own row: the reason or the wait replaces the row's second line.
    const subtitle = feedback && feedback.kind !== 'added' ? feedback.message : entry.subtitle;
    return {
        id: entry.id,
        testID: `${testID}.entry.${entry.id}`,
        label: entry.title,
        ...(subtitle ? { subtitle } : {}),
        icon: <Icon name={entry.icon} size={18} color={entry.added ? colors.text.tertiary : colors.text.secondary} />,
        ...(entry.added
            ? { right: <AddedMark landed={feedback?.kind === 'added'} />, disabled: true }
            : {
                ...(entry.count || feedback ? { right: <EntryOutcome entry={entry} feedback={feedback} testID={`${testID}.entry.${entry.id}`} /> } : {}),
                onPress: () => pick(entry),
            }),
    };
}

/** The glyph for a pick's outcome, landing with a small zoom (a fade under reduced motion). */
function OutcomeGlyph(props: Readonly<{ name: IconName; color: string; testID: string }>): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    return (
        <Animated.View
            testID={props.testID}
            entering={reducedMotion ? FadeIn.duration(motionTokens.successMoment.reducedCrossFadeMs) : ZoomIn.duration(motionTokens.successMoment.checkMs)}
        >
            <Icon name={props.name} size={ICON_SIZE.xs} color={props.color} />
        </Animated.View>
    );
}

/**
 * A tile's or row's trailing slot: how many copies are here, and the last pick's outcome on it —
 * the count ticks to its new value and a check lands; a wait shows a clock, a refusal a warning.
 */
function EntryOutcome(props: Readonly<{ entry: WidgetAddEntry; feedback: AddFeedback | null; testID: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    const { feedback } = props;
    return (
        <View style={stylesheet.outcome}>
            {props.entry.count ? <CountMark count={props.entry.count} tick={feedback?.kind === 'added'} /> : null}
            {feedback?.kind === 'added' ? <OutcomeGlyph name="check" color={theme.colors.text.secondary} testID={`${props.testID}.added`} /> : null}
            {feedback?.kind === 'pending' ? <OutcomeGlyph name="clock" color={theme.colors.text.tertiary} testID={`${props.testID}.pending`} /> : null}
            {feedback?.kind === 'failed' ? <OutcomeGlyph name="warning" color={theme.colors.state.danger.foreground} testID={`${props.testID}.failed`} /> : null}
        </View>
    );
}

function AddedMark(props: Readonly<{ landed?: boolean }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View style={stylesheet.added}>
            {props.landed
                ? <OutcomeGlyph name="check" color={theme.colors.text.tertiary} testID="widget-add.added-check" />
                : <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />}
            <Text style={stylesheet.addedText}>{t('widgetAdd.added')}</Text>
        </View>
    );
}

/**
 * "2 on Home": a configurable widget already here, still pickable for another copy (lab dbind G).
 * After a pick the new count arrives in place (keyed by its value), so "1 on Home" ticks to "2".
 */
function CountMark(props: Readonly<{ count: string; tick?: boolean }>): React.ReactElement {
    const reducedMotion = useReducedMotionPreference();
    return (
        <Animated.View key={props.count} {...(props.tick ? { entering: FadeIn.duration(reducedMotion
            ? motionTokens.successMoment.reducedCrossFadeMs : motionTokens.durationMs.fast) } : {})}>
            <Text style={stylesheet.count} numberOfLines={1}>{props.count}</Text>
        </Animated.View>
    );
}

function GallerySection(props: Readonly<{
    section: WidgetAddSection;
    phone: boolean;
    onPick: (entry: WidgetAddEntry) => void;
    feedback: AddFeedback | null;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { section } = props;
    // Glyph tiles carry no preview, so three share a row on wide surfaces.
    const columns = section.kind === 'make' && !props.phone ? 3 : 2;
    return (
        <View style={styles.section}>
            <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle} accessibilityRole="header">{section.title}</Text>
                <View style={styles.grow} />
                {section.hint ? <Text style={styles.sectionHint} numberOfLines={1}>{section.hint}</Text> : null}
            </View>
            {section.kind === 'chips' ? (
                <View style={styles.chips}>
                    {section.entries.map((entry) => (
                        <PaneChip key={entry.id} entry={entry} onPick={props.onPick} feedback={props.feedback?.entryId === entry.id ? props.feedback : null}
                            testID={`${props.testID}.entry.${entry.id}`} />
                    ))}
                </View>
            ) : (
                <View style={styles.tiles}>
                    {section.entries.map((entry) => (
                        <View key={entry.id} style={{ width: `${100 / columns}%` as const, padding: 4 }}>
                            <Tile entry={entry} onPick={props.onPick} feedback={props.feedback?.entryId === entry.id ? props.feedback : null}
                                testID={`${props.testID}.entry.${entry.id}`} />
                        </View>
                    ))}
                </View>
            )}
        </View>
    );
}

function Tile(props: Readonly<{ entry: WidgetAddEntry; onPick: (entry: WidgetAddEntry) => void; feedback: AddFeedback | null; testID: string }>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { entry, feedback } = props;
    const preview = entry.renderPreview;
    // The second line always keeps its room: a wait or a refusal takes it over in place.
    const second = feedback && feedback.kind !== 'added' ? feedback.message : entry.subtitle ?? '';
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={[entry.title, second || null, entry.added ? t('widgetAdd.added') : entry.count ?? null].filter(Boolean).join(', ')}
            disabled={entry.added === true}
            onPress={() => props.onPick(entry)}
            style={(state) => [
                styles.tile,
                state.hovered || state.pressed ? styles.tileActive : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            {preview ? (
                <View style={[styles.preview, entry.added ? styles.previewAdded : null]} pointerEvents="none">
                    {preview()}
                </View>
            ) : (
                <View style={[styles.preview, styles.previewBlank]} pointerEvents="none">
                    <Icon name={entry.icon} size={22} color={theme.colors.text.tertiary} />
                </View>
            )}
            <View style={styles.label}>
                <View style={styles.labelMark}><Icon name={entry.icon} size={ICON_SIZE.xs} color={theme.colors.text.secondary} /></View>
                <View style={styles.labelText}>
                    <Text style={styles.tileTitle} numberOfLines={1}>{entry.title}</Text>
                    <Text style={[styles.tileSubtitle, feedback?.kind === 'failed' ? styles.tileSubtitleFailed : null]} numberOfLines={1}
                        testID={`${props.testID}.second`}>
                        {second}
                    </Text>
                </View>
                {entry.added ? <AddedMark landed={feedback?.kind === 'added'} />
                    : entry.count || feedback ? <EntryOutcome entry={entry} feedback={feedback} testID={props.testID} /> : null}
            </View>
        </HappierPressable>
    );
}

function PaneChip(props: Readonly<{ entry: WidgetAddEntry; onPick: (entry: WidgetAddEntry) => void; feedback: AddFeedback | null; testID: string }>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { entry, feedback } = props;
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={[entry.title, feedback?.message, entry.added ? t('widgetAdd.added') : null].filter(Boolean).join(', ')}
            disabled={entry.added === true}
            onPress={() => props.onPick(entry)}
            style={(state) => [
                styles.chip,
                entry.added ? styles.chipAdded : null,
                state.pressed ? styles.tileActive : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            <Icon name={entry.icon} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text style={[styles.chipLabel, entry.added ? styles.chipLabelAdded : null]}>{feedback && feedback.kind !== 'added' ? `${entry.title} · ${feedback.message}` : entry.title}</Text>
            {feedback ? <EntryOutcome entry={entry} feedback={feedback} testID={props.testID} />
                : entry.added ? <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} /> : null}
        </HappierPressable>
    );
}

function AskTile(props: Readonly<{ ask: WidgetAddAsk; onPick: () => void; testID: string }>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.askWrap}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={`${props.ask.title}. ${props.ask.note}`}
                onPress={props.onPick}
                style={(state) => [
                    styles.ask,
                    state.hovered || state.pressed ? styles.tileActive : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                ]}
            >
                <Icon name="sparkle" size={16} color={theme.colors.text.secondary} />
                <View style={styles.askBody}>
                    <Text style={styles.tileTitle}>{props.ask.title}</Text>
                    <View style={styles.askDraft}>
                        <Text style={styles.askDraftText} numberOfLines={1}>
                            {props.ask.draft}
                            <Text style={styles.askDraftEllipsis}>…</Text>
                        </Text>
                    </View>
                    <Text style={styles.tileSubtitle}>{props.ask.note}</Text>
                </View>
            </HappierPressable>
        </View>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    root: { paddingHorizontal: 6, paddingTop: 6, paddingBottom: 6 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6, paddingTop: 4, paddingBottom: 8 },
    titleBlock: { flex: 1, minWidth: 0, gap: 2 },
    title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary },
    hint: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
    done: { paddingHorizontal: 6, paddingVertical: 8, borderRadius: MENU_ROW_METRICS.radiusPx },
    doneLabel: { ...Typography.default('semiBold'), ...happierPageTextMetrics('rowTitle'), color: theme.colors.text.link },
    switchRow: { paddingHorizontal: 2, paddingBottom: 10 },
    search: { marginHorizontal: 4, marginBottom: 4 },
    section: { paddingTop: 6, paddingBottom: 2 },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 4 },
    sectionTitle: { ...Typography.default('semiBold'), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary },
    sectionHint: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary, flexShrink: 1 },
    grow: { flex: 1 },
    tiles: { flexDirection: 'row', flexWrap: 'wrap' },
    tile: { borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx, padding: TILE_PADDING_PX, gap: 6 },
    tileActive: { backgroundColor: theme.colors.surface.pressed },
    preview: {
        height: PREVIEW_HEIGHT_PX,
        borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx - TILE_PADDING_PX,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        paddingVertical: 8,
        paddingHorizontal: 10,
    },
    previewAdded: { opacity: 0.55 },
    previewBlank: { height: BLANK_PREVIEW_HEIGHT_PX, alignItems: 'center', justifyContent: 'center' },
    label: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 2 },
    // The mark sits on the title's line.
    labelMark: { height: happierPageTextMetrics('rowTitle').lineHeight, justifyContent: 'center' },
    labelText: { flex: 1, minWidth: 0 },
    tileTitle: { ...Typography.default('semiBold'), ...happierPageTextMetrics('rowTitle'), color: theme.colors.text.primary },
    tileSubtitle: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        minHeight: happierPageTextMetrics('rowDescription').lineHeight,
        color: theme.colors.text.tertiary,
    },
    tileSubtitleFailed: { color: theme.colors.state.danger.foreground },
    outcome: { flexDirection: 'row', alignItems: 'center', gap: 4, height: happierPageTextMetrics('rowTitle').lineHeight },
    added: { flexDirection: 'row', alignItems: 'center', gap: 3, height: happierPageTextMetrics('rowTitle').lineHeight },
    count: { ...Typography.default('semiBold'), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
    addedText: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 6, paddingBottom: 4 },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: CHIP_HEIGHT_PX,
        paddingLeft: 9,
        paddingRight: 11,
        borderRadius: CHIP_HEIGHT_PX / 2,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    chipAdded: { backgroundColor: theme.colors.surface.selected, borderColor: 'transparent' },
    chipLabel: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.primary },
    chipLabelAdded: { color: theme.colors.text.secondary },
    askWrap: { paddingHorizontal: 4, paddingTop: 4, paddingBottom: 2 },
    ask: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx,
        paddingVertical: 10,
        paddingHorizontal: 12,
        backgroundColor: theme.colors.surface.inset,
    },
    askBody: { flex: 1, minWidth: 0, gap: 4 },
    askDraft: {
        borderRadius: MENU_ROW_METRICS.radiusPx,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingVertical: 6,
        paddingHorizontal: 9,
    },
    askDraftText: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary },
    askDraftEllipsis: { color: theme.colors.text.tertiary },
    empty: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary, paddingHorizontal: 10, paddingVertical: 10 },
}));
