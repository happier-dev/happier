import * as React from 'react';
import { AccessibilityInfo, Platform, ScrollView, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HAPPIER_COLLECTION_LIST_METRICS,
    HAPPIER_COLLECTION_LIST_TEXT,
    HAPPIER_WIDGET_FRAME_METRICS,
    HappierPressable,
    happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { WidgetFlowPanel, WidgetPreviewWell } from '@/components/widgets/flow/WidgetFlowPanel';
import { WidgetFlowStep, WidgetSheetDone, WidgetSheetShell } from '@/components/widgets/flow/WidgetFlowShell';

import { WidgetAddPluginMark } from './WidgetAddPluginMark';
import { WidgetSetupStep } from './WidgetSetupStep';
import type { WidgetSetupSubmitResult } from './widgetSetupModel';
import {
    filterWidgetAddSections,
    matchesWidgetAddAsk,
    stepWidgetAddSelection,
    type WidgetAddAsk,
    type WidgetAddEntry,
    type WidgetAddSection,
} from './widgetAddModel';

/**
 * The Add surface's one composition per width (lab `widget-add` wsplit A, wpop B): a fixed surface
 * that never changes size while you browse. Wide enough for the list beside the widget, it splits;
 * narrower (a small window, a Companion column), the list pushes the same pane.
 */
export const WIDGET_ADD_SURFACE_PX = Object.freeze({
    width: 960,
    narrowWidth: 600,
    height: 624,
    listWidth: 316,
    splitMinWidth: 880,
});

const ASK_ID = 'ask';
/** A plugin section's mark sits on its label's line. */
const GROUP_MARK_PX = HAPPIER_COLLECTION_LIST_TEXT.groupTitle.lineHeight - 2;

/** A list text step (the Collection list's type rhythm) in core's own family for its weight. */
function listText(role: keyof typeof HAPPIER_COLLECTION_LIST_TEXT) {
    const step = HAPPIER_COLLECTION_LIST_TEXT[role];
    return { ...Typography.default(step.weight), fontSize: step.fontSize, lineHeight: step.lineHeight };
}

export type WidgetAddPanelProps = Readonly<{
    title: string;
    /** Who sees what you add ("Everyone here sees what you add"). */
    hint?: string;
    searchPlaceholder: string;
    sections: readonly WidgetAddSection[];
    ask?: WidgetAddAsk;
    /** Where an entry without its own setup goes ("Add to Home"). */
    addLabel: string;
    /** `split`: list beside the selected widget; `push`: the list pushes the widget's pane. */
    composition: 'split' | 'push';
    /** Phones: the sheet's Done closes, and the pane recomposes for the phone. */
    phone?: boolean;
    /** Opened on a widget chosen elsewhere (Add to board's list). */
    initialEntryId?: string;
    onRequestClose: () => void;
    /** Exact Home/session identity for the pane's option reads. */
    serverId?: string | null;
    sessionId?: string | null;
    testID: string;
}>;

/**
 * What became of the last Add, kept on its row and on the pane's line (never a line that pushes the
 * list down): added — its count ticks and a check lands; waiting for someone's approval; or refused.
 */
type AddFeedback = Readonly<{ entryId: string; kind: 'added' | 'pending' | 'failed'; message: string }>;

function feedbackFor(entry: Readonly<{ id: string; title: string }>, result: WidgetSetupSubmitResult): AddFeedback {
    if (!result.ok) return { entryId: entry.id, kind: 'failed', message: result.message };
    return result.approvalPending
        ? { entryId: entry.id, kind: 'pending', message: t('widgetAdd.areaApprovalPending') }
        : { entryId: entry.id, kind: 'added', message: t('widgetAdd.justAdded', { widget: entry.title }) };
}

/**
 * The one Add surface for widgets on every placement: Home, a WorkBoard, a Session Board, the
 * Companion and plugin areas. Anchored to the control that opened it on desktop, the app's bottom
 * sheet on a phone. Mounted only while open, so a closed Add reads and previews nothing.
 */
export function WidgetAddSurface(props: Omit<WidgetAddPanelProps, 'composition' | 'phone'> & Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    placement?: 'top' | 'bottom';
}>): React.ReactElement | null {
    const phone = useDeviceType() === 'phone';
    if (!props.open) return null;
    const { open: _open, anchorRef, placement, ...panel } = props;
    if (phone) {
        return (
            <WidgetSheetShell title={props.title} onRequestClose={props.onRequestClose} testID={`${props.testID}.sheet`}>
                <WidgetAddPanel {...panel} composition="push" phone />
            </WidgetSheetShell>
        );
    }
    return (
        <Popover
            open
            anchorRef={anchorRef}
            placement={placement ?? 'bottom'}
            gap={8}
            maxHeightCap={WIDGET_ADD_SURFACE_PX.height}
            maxWidthCap={WIDGET_ADD_SURFACE_PX.width}
            edgePadding={{ vertical: 8, horizontal: 8 }}
            portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
            onRequestClose={props.onRequestClose}
            backdrop={{ effect: 'none', closeOnPan: true }}
        >
            {({ maxHeight, maxWidth }) => <AnchoredWidgetAddContent panel={panel} maxHeight={maxHeight} maxWidth={maxWidth} />}
        </Popover>
    );
}

/**
 * The anchored surface's one composition, decided by the room the Popover first finds and then kept
 * for as long as it is open: the surface never changes shape while you browse, and a later
 * remeasure cannot move the selected widget's pane (and its draft) to another place in the tree.
 */
function AnchoredWidgetAddContent(props: Readonly<{
    panel: Omit<WidgetAddPanelProps, 'composition' | 'phone'>;
    maxHeight: number;
    maxWidth: number;
}>): React.ReactElement {
    const [split] = React.useState(() => props.maxWidth >= WIDGET_ADD_SURFACE_PX.splitMinWidth);
    const width = Math.min(props.maxWidth, split ? WIDGET_ADD_SURFACE_PX.width : WIDGET_ADD_SURFACE_PX.narrowWidth);
    const height = Math.min(props.maxHeight, WIDGET_ADD_SURFACE_PX.height);
    return (
        <View style={{ alignSelf: 'flex-end', width }}>
            <FloatingOverlay maxHeight={height} scrollEnabled={false} keyboardShouldPersistTaps="always">
                <View style={{ height }}>
                    <WidgetAddPanel {...props.panel} composition={split ? 'split' : 'push'} />
                </View>
            </FloatingOverlay>
        </View>
    );
}

/**
 * The surface's content (lab wsplit A): a grouped, searchable list — Built in, each plugin by its
 * own name, Your widgets — and the selected widget's pane: who it is, inputs first, its real body at
 * its real size with the declared sizes under it, and one footer with Add (⌘↵). Only the selected
 * widget mounts a live body, and it opens with nothing selected, so opening Add reads nothing.
 *
 * The surface owns no data and no write path: a widget's Add is its setup's canonical Action, and
 * any other entry's Add is the placement's own `onPick`. It stays open after an Add so another can
 * follow, unless the entry hands the focus elsewhere.
 */
export function WidgetAddPanel(props: WidgetAddPanelProps): React.ReactElement {
    const styles = stylesheet;
    const [query, setQuery] = React.useState('');
    const [selectedId, setSelectedId] = React.useState<string | null>(props.initialEntryId ?? null);
    // The narrow composition shows the list or the selected widget's pane, one at a time.
    const [pushed, setPushed] = React.useState(props.initialEntryId !== undefined);
    const [direction, setDirection] = React.useState<'none' | 'forward' | 'backward'>('none');
    const [feedback, setFeedback] = React.useState<AddFeedback | null>(null);
    React.useEffect(() => {
        if (feedback) AccessibilityInfo.announceForAccessibility?.(feedback.message);
    }, [feedback]);

    const sections = React.useMemo(() => filterWidgetAddSections(props.sections, query), [props.sections, query]);
    const ask = props.ask && matchesWidgetAddAsk(props.ask, query) ? props.ask : null;
    const askEntry = React.useMemo<WidgetAddEntry | null>(() => (props.ask ? {
        id: ASK_ID, title: props.ask.title, subtitle: props.ask.note, icon: 'sparkle', closesOnPick: true,
        actionLabel: t('widgetAdd.askAction'), onPick: props.ask.onPick,
    } : null), [props.ask]);
    const visibleIds = React.useMemo(() => [
        ...sections.flatMap((section) => section.entries.map((entry) => entry.id)),
        ...(ask ? [ASK_ID] : []),
    ], [ask, sections]);
    // The selection survives a search that hides its row: the pane keeps showing what was chosen.
    const selected = React.useMemo(() => (selectedId === ASK_ID ? askEntry
        : props.sections.flatMap((section) => section.entries).find((entry) => entry.id === selectedId) ?? null), [askEntry, props.sections, selectedId]);

    const split = props.composition === 'split';
    const select = React.useCallback((id: string) => {
        setSelectedId(id);
        if (!split) { setPushed(true); setDirection('forward'); }
    }, [split]);
    const back = React.useCallback(() => { setPushed(false); setDirection('backward'); }, []);

    // The selected widget's Add, for ⌘↵ and ↵: its setup registers its own submit.
    const commandRef = React.useRef<(() => void) | null>(null);
    const [busy, setBusy] = React.useState(false);
    const close = props.onRequestClose;
    const pickEntry = React.useCallback((entry: WidgetAddEntry) => {
        const run = entry.onPick;
        if (busy || entry.added || !run) return;
        setFeedback(null);
        const result = run();
        if (result) {
            setBusy(true);
            void result.then(
                (outcome) => setFeedback(feedbackFor(entry, outcome)),
                () => setFeedback(feedbackFor(entry, { ok: false, message: t('widgetAdd.addFailed') })),
            ).finally(() => setBusy(false));
        }
        if (entry.closesOnPick) close();
    }, [busy, close]);
    const addSelected = React.useCallback(() => {
        if (!selected) return;
        if (selected.setup) commandRef.current?.();
        else pickEntry(selected);
    }, [pickEntry, selected]);

    const onSearchKey = React.useCallback((event: Readonly<{ nativeEvent: { key: string }; preventDefault?: () => void }>) => {
        const key = event.nativeEvent.key;
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault?.();
            const next = stepWidgetAddSelection(visibleIds, selectedId, key === 'ArrowDown' ? 1 : -1);
            if (next) setSelectedId(next);
            return;
        }
        if (key === 'Enter' && selectedId !== null) {
            event.preventDefault?.();
            if (split) addSelected();
            else select(selectedId);
            return;
        }
        if (key === 'Escape' && query.length > 0) {
            event.preventDefault?.();
            setQuery('');
        }
    }, [addSelected, query.length, select, selectedId, split, visibleIds]);
    // ⌘↵ / Ctrl+↵ adds from anywhere in the surface once the selected widget is ready.
    const onKeyDown = React.useCallback((event: Readonly<{ key: string; metaKey?: boolean; ctrlKey?: boolean; preventDefault?: () => void }>) => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault?.();
        addSelected();
    }, [addSelected]);

    const onDone = React.useCallback((entry: WidgetAddEntry, result: WidgetSetupSubmitResult) => setFeedback(feedbackFor(entry, result)), []);
    const list = (
        <WidgetAddList
            {...props}
            query={query}
            onQueryChange={setQuery}
            onSearchKey={onSearchKey}
            sections={sections}
            askEntry={ask ? askEntry : null}
            selectedId={selectedId}
            feedback={feedback}
            onSelect={select}
        />
    );
    const detail = (
        <WidgetAddDetail
            entry={selected}
            ask={selectedId === ASK_ID ? props.ask ?? null : null}
            addLabel={props.addLabel}
            phone={props.phone === true}
            feedback={feedback?.entryId === selected?.id ? feedback : null}
            busy={busy}
            commandRef={commandRef}
            onPick={pickEntry}
            onDone={onDone}
            {...(split ? { onClose: close } : { onBack: back })}
            {...(props.serverId ? { serverId: props.serverId } : {})}
            {...(props.sessionId ? { sessionId: props.sessionId } : {})}
            emptyTestID={`${props.testID}.empty`}
            testID={`${props.testID}.detail`}
        />
    );
    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.title}
            style={[styles.root, split ? styles.rootSplit : null]}
            {...(Platform.OS === 'web' ? { onKeyDown } : {})}
        >
            {split ? (
                <>
                    <View style={styles.listColumn}>{list}</View>
                    <View style={styles.detailColumn}>{detail}</View>
                </>
            ) : pushed && selected ? (
                <WidgetFlowStep key={`detail:${selected.id}`} direction={direction} fill={!props.phone}>{detail}</WidgetFlowStep>
            ) : (
                <WidgetFlowStep key="list" direction={direction} fill={!props.phone}>{list}</WidgetFlowStep>
            )}
        </View>
    );
}

/** The left column: title and who sees it, search, then the sections as rows. */
function WidgetAddList(props: WidgetAddPanelProps & Readonly<{
    query: string;
    onQueryChange: (query: string) => void;
    onSearchKey: (event: Readonly<{ nativeEvent: { key: string }; preventDefault?: () => void }>) => void;
    askEntry: WidgetAddEntry | null;
    selectedId: string | null;
    feedback: AddFeedback | null;
    onSelect: (id: string) => void;
}>): React.ReactElement {
    const styles = stylesheet;
    const split = props.composition === 'split';
    const nothing = props.sections.length === 0 && !props.askEntry;
    const row = (entry: WidgetAddEntry) => (
        <WidgetAddRow key={entry.id} entry={entry} selected={props.selectedId === entry.id}
            feedback={props.feedback?.entryId === entry.id ? props.feedback : null}
            onSelect={props.onSelect} testID={`${props.testID}.entry.${entry.id}`} />
    );
    return (
        <View style={props.phone ? null : styles.fill}>
            <View style={styles.listHeader}>
                <View style={styles.titleBlock}>
                    <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{props.title}</Text>
                    {props.hint ? <Text style={styles.hint} numberOfLines={1}>{props.hint}</Text> : null}
                </View>
                {props.phone ? (
                    <WidgetSheetDone testID={`${props.testID}.done`} onPress={props.onRequestClose} />
                ) : !split ? (
                    <IconButton testID={`${props.testID}.close`} iconName="x" variant="plain" accessibilityLabel={t('common.close')} onPress={props.onRequestClose} />
                ) : null}
            </View>
            <CompactSearchField
                value={props.query}
                onChangeText={props.onQueryChange}
                placeholder={props.searchPlaceholder}
                testID={`${props.testID}.search`}
                style={styles.search}
                onKeyPress={props.onSearchKey}
                {...(Platform.OS === 'web' && !props.phone ? { autoFocus: true } : {})}
            />
            <ScrollView style={props.phone ? null : styles.fill} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="always">
                {props.sections.map((section) => (
                    <View key={section.id} style={styles.section} accessibilityLabel={section.title}>
                        <View style={styles.sectionHeader}>
                            {section.pluginId ? <WidgetAddPluginMark pluginId={section.pluginId} size={GROUP_MARK_PX} testID={`${props.testID}.section.${section.id}.mark`} /> : null}
                            <Text style={styles.sectionTitle} accessibilityRole="header" numberOfLines={1}>{section.title}</Text>
                            {section.hint ? <Text style={styles.sectionHint} numberOfLines={1}>{section.hint}</Text> : null}
                        </View>
                        {section.entries.map(row)}
                    </View>
                ))}
                {props.askEntry ? <View style={styles.section}>{row(props.askEntry)}</View> : null}
                {nothing ? (
                    <Text style={styles.empty} testID={`${props.testID}.noMatch`}>{t('widgetAdd.noMatch', { query: props.query.trim() })}</Text>
                ) : null}
            </ScrollView>
        </View>
    );
}

/** One row: the widget's mark, its name and one line of purpose, and a trailing fact or outcome. */
const WidgetAddRow = React.memo(function WidgetAddRow(props: Readonly<{
    entry: WidgetAddEntry;
    selected: boolean;
    feedback: AddFeedback | null;
    onSelect: (id: string) => void;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { entry, feedback } = props;
    const row = (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="option"
            selected={props.selected}
            accessibilityLabel={[entry.title, entry.subtitle ?? null, entry.added ? t('widgetAdd.added') : entry.count ?? null].filter(Boolean).join(', ')}
            onPress={() => props.onSelect(entry.id)}
            style={(state) => [
                styles.row,
                entry.actions?.length ? styles.rowPick : null,
                props.selected ? styles.rowSelected : state.hovered || state.pressed ? styles.rowHover : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            <View style={styles.rowMark}>
                <Icon name={entry.icon} size={ICON_SIZE.sm} color={props.selected ? theme.colors.text.primary : theme.colors.text.secondary} />
            </View>
            <View style={styles.rowText}>
                <View style={styles.rowTop}>
                    <Text style={[styles.rowTitle, props.selected ? styles.rowTitleSelected : null, entry.added ? styles.rowTitleAdded : null]} numberOfLines={1}>{entry.title}</Text>
                    <RowTrailing entry={entry} feedback={feedback} testID={props.testID} />
                </View>
                {entry.subtitle ? <Text style={styles.rowSubtitle} numberOfLines={1}>{entry.subtitle}</Text> : null}
            </View>
        </HappierPressable>
    );
    return entry.actions?.length ? (
        <View style={styles.rowWithActions}>
            {row}
            <ItemRowActions title={entry.title} actions={entry.actions} overflowOnly overflowTriggerTestID={`${props.testID}.actions`} />
        </View>
    ) : row;
});

/** The glyph for an Add's outcome, landing with a small zoom (a fade under reduced motion). */
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
 * A row's trailing slot: "2 on Home" (a new count arrives in place after an Add), "Added" for a
 * widget a second copy of which would be the same, and the last Add's outcome glyph.
 */
function RowTrailing(props: Readonly<{ entry: WidgetAddEntry; feedback: AddFeedback | null; testID: string }>): React.ReactElement | null {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const { entry, feedback } = props;
    if (!entry.count && !entry.added && !feedback) return null;
    return (
        <View style={styles.trailing}>
            {entry.count ? (
                <Animated.View key={entry.count} {...(feedback?.kind === 'added' ? { entering: FadeIn.duration(reducedMotion
                    ? motionTokens.successMoment.reducedCrossFadeMs : motionTokens.durationMs.fast) } : {})}>
                    <Text style={styles.count} numberOfLines={1}>{entry.count}</Text>
                </Animated.View>
            ) : null}
            {entry.added && feedback?.kind !== 'added' ? (
                <>
                    <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                    <Text style={styles.addedText}>{t('widgetAdd.added')}</Text>
                </>
            ) : null}
            {feedback?.kind === 'added' ? <OutcomeGlyph name="check" color={theme.colors.text.secondary} testID={`${props.testID}.added`} /> : null}
            {feedback?.kind === 'pending' ? <OutcomeGlyph name="clock" color={theme.colors.text.tertiary} testID={`${props.testID}.pending`} /> : null}
            {feedback?.kind === 'failed' ? <OutcomeGlyph name="warning" color={theme.colors.state.danger.foreground} testID={`${props.testID}.failed`} /> : null}
        </View>
    );
}

/**
 * The right side: nothing selected (what Add will show, and its keys), a widget's setup pane, or the
 * pane of an entry without one (a note, a pane link, the ask).
 */
function WidgetAddDetail(props: Readonly<{
    entry: WidgetAddEntry | null;
    ask: WidgetAddAsk | null;
    addLabel: string;
    phone: boolean;
    feedback: AddFeedback | null;
    busy: boolean;
    commandRef: React.MutableRefObject<(() => void) | null>;
    onPick: (entry: WidgetAddEntry) => void;
    onDone: (entry: WidgetAddEntry, result: WidgetSetupSubmitResult) => void;
    onBack?: () => void;
    onClose?: () => void;
    serverId?: string;
    sessionId?: string;
    emptyTestID: string;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { entry } = props;
    // Built when its entry is selected; a new selection is a new pane with its own draft.
    const setup = React.useMemo(() => entry?.setup?.() ?? null, [entry]);
    const keys = Platform.OS === 'web' && !props.phone ? <ShortcutHint /> : null;
    const nav = { ...(props.onBack ? { onBack: props.onBack } : {}), ...(props.onClose ? { onClose: props.onClose } : {}) };
    if (entry && setup) {
        return (
            <WidgetSetupStep
                key={entry.id}
                setup={setup}
                phone={props.phone}
                presentation="pane"
                {...nav}
                {...(props.onBack && props.phone ? { backLabel: t('widgetAdd.backToWidgets') } : {})}
                notice={props.feedback && props.feedback.kind !== 'failed' ? props.feedback.message : null}
                blockedReason={entry.added ? t('widgetAdd.added') : null}
                footerAccessory={keys}
                commandRef={props.commandRef}
                onDone={(result) => props.onDone(entry, result)}
                onRefused={(message) => props.onDone(entry, { ok: false, message })}
                {...(props.serverId ? { serverId: props.serverId } : {})}
                {...(props.sessionId ? { sessionId: props.sessionId } : {})}
                testID={props.testID}
            />
        );
    }
    if (entry) {
        const preview = props.ask ? (
            <View style={styles.askDraft}>
                <Text style={styles.askDraftText}>{props.ask.draft}<Text style={styles.askDraftEllipsis}>…</Text></Text>
            </View>
        ) : entry.renderPreview ? (
            <WidgetPreviewWell testID={`${props.testID}.preview`} caption={t('widgetAdd.preview')}>{entry.renderPreview()}</WidgetPreviewWell>
        ) : null;
        return (
            <WidgetFlowPanel
                key={entry.id}
                testID={props.testID}
                phone={props.phone}
                fill={!props.phone}
                mark={entry.icon}
                title={entry.title}
                hint={entry.subtitle ?? null}
                {...nav}
                {...(props.onBack && props.phone ? { backLabel: t('widgetAdd.backToWidgets') } : {})}
                noteTestID={`${props.testID}.why`}
                error={props.feedback?.kind === 'failed' ? props.feedback.message : null}
                note={entry.added ? t('widgetAdd.added') : props.feedback?.message ?? null}
                {...(keys && !entry.added ? { footerAccessory: keys } : {})}
                primary={{
                    testID: `${props.testID}.submit`,
                    label: entry.actionLabel ?? props.addLabel,
                    ...(entry.actionLabel ? {} : { icon: 'plus' as const }),
                    onPress: () => props.onPick(entry),
                    disabled: entry.added === true,
                    busy: props.busy,
                }}
            >
                {preview}
            </WidgetFlowPanel>
        );
    }
    return (
        <WidgetFlowPanel
            testID={props.testID}
            phone={props.phone}
            fill={!props.phone}
            title=""
            {...(props.onClose ? { onClose: props.onClose } : {})}
            noteTestID={`${props.testID}.why`}
            note={t('widgetAdd.pickNote')}
            primary={{ testID: `${props.testID}.submit`, label: props.addLabel, icon: 'plus', onPress: () => {}, disabled: true }}
        >
            <View testID={props.emptyTestID} style={styles.empty}>
                <Icon name="squares-four" size={ICON_SIZE.lg} color={theme.colors.text.tertiary} />
                <Text style={styles.emptyTitle}>{t('widgetAdd.pickTitle')}</Text>
                <Text style={styles.emptyBody}>{t('widgetAdd.pickHint')}</Text>
            </View>
        </WidgetFlowPanel>
    );
}

/** ⌘↵ beside Add, in the shortcut keys' quiet type. */
function ShortcutHint(): React.ReactElement {
    const styles = stylesheet;
    return (
        <View style={styles.keys} accessible={false} importantForAccessibility="no-hide-descendants">
            <Text style={styles.key}>⌘</Text>
            <Text style={styles.key}>↵</Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0 },
    rootSplit: { flexDirection: 'row' },
    fill: { flex: 1, minHeight: 0 },
    listColumn: {
        width: WIDGET_ADD_SURFACE_PX.listWidth,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.border.default,
    },
    detailColumn: { flex: 1, minWidth: 0, minHeight: 0, paddingHorizontal: 8, paddingTop: 6 },
    listHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: HAPPIER_COLLECTION_LIST_METRICS.contentInset - 4, paddingRight: 10, paddingTop: HAPPIER_COLLECTION_LIST_METRICS.headerPaddingTop + 4, paddingBottom: 8 },
    titleBlock: { flex: 1, minWidth: 0, gap: 1 },
    title: { ...listText('title'), color: theme.colors.text.primary },
    hint: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
    search: { marginHorizontal: 10, marginBottom: 4 },
    // The Collection list's column geometry and type rhythm (`HAPPIER_COLLECTION_LIST_*`).
    listContent: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset - 4, paddingBottom: 10 },
    section: { paddingTop: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingLeft: HAPPIER_COLLECTION_LIST_METRICS.contentInset - HAPPIER_COLLECTION_LIST_METRICS.rowInset,
        paddingRight: 8,
        paddingTop: HAPPIER_COLLECTION_LIST_METRICS.groupLabelPaddingTop - HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop,
        paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelPaddingBottom,
    },
    sectionTitle: { ...listText('groupTitle'), color: theme.colors.text.secondary, flexShrink: 0 },
    sectionHint: { ...listText('groupCount'), color: theme.colors.text.tertiary, flexShrink: 1 },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
        paddingVertical: 7,
        paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.contentInset - HAPPIER_COLLECTION_LIST_METRICS.rowInset,
        borderRadius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
    },
    rowHover: { backgroundColor: theme.colors.surface.pressed },
    rowWithActions: { flexDirection: 'row', alignItems: 'center' },
    rowPick: { flex: 1, minWidth: 0 },
    rowSelected: { backgroundColor: theme.colors.surface.selected },
    // The mark sits on the title's line.
    rowMark: { width: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox, height: HAPPIER_COLLECTION_LIST_TEXT.rowTitle.lineHeight, alignItems: 'center', justifyContent: 'center' },
    rowText: { flex: 1, minWidth: 0 },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    rowTitle: { ...listText('rowTitle'), color: theme.colors.text.primary, flex: 1, minWidth: 0 },
    rowTitleSelected: listText('rowTitleSelected'),
    rowTitleAdded: { color: theme.colors.text.secondary },
    rowSubtitle: { ...listText('groupCount'), color: theme.colors.text.tertiary },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: 4, height: HAPPIER_COLLECTION_LIST_TEXT.rowTitle.lineHeight, flexShrink: 0 },
    count: { ...listText('groupCount'), color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
    addedText: { ...listText('groupCount'), color: theme.colors.text.tertiary },
    empty: { flex: 1, minHeight: 200, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 32 },
    emptyTitle: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary, textAlign: 'center' },
    emptyBody: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary, textAlign: 'center', maxWidth: 340 },
    keys: { flexDirection: 'row', gap: 3 },
    key: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        minWidth: 18,
        textAlign: 'center',
        paddingHorizontal: 4,
        borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx / 2,
        backgroundColor: theme.colors.surface.inset,
        // A key, not a tag: the cap's lower lip (lab wsplit A1).
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        overflow: 'hidden',
        color: theme.colors.text.secondary,
    },
    askDraft: {
        borderRadius: MENU_ROW_METRICS.radiusPx,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingVertical: 10,
        paddingHorizontal: 12,
    },
    askDraftText: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary },
    askDraftEllipsis: { color: theme.colors.text.tertiary },
}));
