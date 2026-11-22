import * as React from 'react';
import { View, Platform, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { MarkdownView, type MarkdownInlineReferences } from '@/components/markdown/MarkdownView';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { useMeasuredNearViewport, type NearViewportTracker } from '@/components/widgets/nearViewport';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';
import { CODE_LINE_BASE_HEIGHT } from '@/components/ui/code/view/CodeLineRow';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { HAPPIER_UI_FONT_SCALE_CSS_VAR } from '@/components/ui/text/webUnistylesFontOverrides';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { KeyboardCommandHint } from '@/components/ui/keyboard/KeyHint';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WalkthroughReviewExplanation } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { RAIL_STOP_NUMBER_PX, WalkthroughStopNumber } from './WalkthroughAtoms';
import { WalkthroughStopExchangeList } from './WalkthroughStopExchanges';
import { ScmChangeRow } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';
import type { WalkthroughStop, WalkthroughStopFile } from './walkthroughReading';
import type { ChangedFilesReviewFindModel } from '@/components/workspaces/scm/review/useChangedFilesReviewFind';
import { ChangedFilesReviewFindCount } from '@/components/workspaces/scm/review/ChangedFilesReviewFind';
import { walkthroughStopFindKey } from './walkthroughFind';
import type { WalkthroughReviewedSource } from './walkthroughReviewedProjection';
import { useWalkthroughReviewedStop } from './useWalkthroughReviewed';

/** Find over the reading: the review Find model, whether it is open, and the place its current match is in. */
export type WalkthroughFindProps = Readonly<{
    model: ChangedFilesReviewFindModel;
    active: boolean;
    target: Readonly<{ filePath: string; lineId: string }> | null;
    /** Native: lands a find target's window offset in the reading's one scroll owner. */
    onScrollToLine?: (windowY: number) => void;
}>;

function fileName(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}

class HunkEvidenceBoundary extends React.Component<Readonly<{ children: React.ReactNode; fallback: React.ReactNode }>, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** The stream's physical viewport admits reads for its deferred cards. */
export const WalkthroughEvidencePresentation = React.createContext<Readonly<{
    present: (path: string) => void;
    nativeViewport: NearViewportTracker | null;
}> | null>(null);

function PresentEvidence(props: Readonly<{ path: string; present: (path: string) => void }>) {
    React.useEffect(() => { props.present(props.path); }, [props.present, props.path]);
    return null;
}

function NativeEvidenceFrame(props: React.PropsWithChildren<Readonly<{
    path: string; present: (path: string) => void; viewport: NearViewportTracker;
}>>) {
    const ref = React.useRef<View>(null);
    const { near, measure } = useMeasuredNearViewport(props.viewport, ref, true, props.path);
    return <View ref={ref} collapsable={false} onLayout={measure}>
        {props.children}
        {near ? <PresentEvidence path={props.path} present={props.present} /> : null}
    </View>;
}

/** The reading hint beside a stop's title: where to read, never a verdict (lab WT1-A). */
export function resolveWalkthroughImportanceLabel(stop: Pick<WalkthroughStop, 'number' | 'importance'>): string | null {
    if (stop.number === 1 && stop.importance !== 'low') return t('walkthrough.importance.start');
    if (stop.importance === 'high') return t('walkthrough.importance.high');
    if (stop.importance === 'low') return t('walkthrough.importance.low');
    return null;
}

/**
 * The rows the hunk card's highlighted diff draws, so its reserved body is exactly the code it will hold: every
 * code line, plus one separator row for each hunk that follows unmodified lines. Raw `@@` headers are never drawn.
 */
function reservedDiffRows(unifiedDiff: string): number {
    let rows = 0;
    for (const line of buildCodeLinesFromUnifiedDiff({ unifiedDiff })) {
        // The "\ No newline at end of file" marker is not a line the highlighted diff draws.
        if (!line.renderIsHeaderLine) { if (!(line.renderPrefixText === '' && (line.renderCodeText ?? '').startsWith('\\'))) rows += 1; }
        else if (/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)/.exec(line.renderCodeText ?? '')?.slice(1).some((start) => Number(start) > 1)) rows += 1;
    }
    return rows;
}

/** One file's exact hunks for a stop, as a quiet card: path, range, counts and the shared diff renderer. */
export const WalkthroughHunkCard = React.memo(function WalkthroughHunkCard(props: Readonly<{
    file: Pick<WalkthroughStopFile, 'path' | 'changeKind' | 'unifiedDiff' | 'rangeLabel' | 'added' | 'removed' | 'unavailableReason'> & Partial<Pick<WalkthroughStopFile, 'previousPath' | 'deferred'>>;
    phone?: boolean;
    onOpenFile?: (path: string) => void;
    /** This card's Find key and the reading's Find state; absent draws the code without Find. */
    findKey?: string;
    find?: WalkthroughFindProps | null;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const file = props.file;
    const presentation = React.useContext(WalkthroughEvidencePresentation);
    const find = props.find && props.findKey ? props.find : null;
    const findKey = props.findKey ?? '';
    const findModel = find?.model;
    const findSnapshot = React.useSyncExternalStore(
        React.useCallback((listener: () => void) => findModel?.subscribeFile(findKey, listener) ?? (() => {}), [findModel, findKey]),
        () => findModel?.getFileSnapshot(findKey),
    );
    const registerFindRefold = React.useCallback((refold: Parameters<ChangedFilesReviewFindModel['registerRefold']>[1]) =>
        findModel?.registerRefold(findKey, refold), [findModel, findKey]);
    const findTargetLineId = find?.target?.filePath === findKey ? find.target.lineId : undefined;
    const rows = React.useMemo(() => file.unifiedDiff ? reservedDiffRows(file.unifiedDiff) : 0, [file.unifiedDiff]);
    const reservedHeight = rows * CODE_LINE_BASE_HEIGHT;
    // Web code typography follows the canonical font-scale variable; native rows use the same base metric.
    const bodyStyle = Platform.OS === 'web'
        ? { minHeight: `calc(${reservedHeight}px * var(${HAPPIER_UI_FONT_SCALE_CSS_VAR}, 1))` } as unknown as ViewStyle
        : { minHeight: reservedHeight };
    const evidence = (reason: string | null) => (
        <View testID={`walkthrough-evidence-${file.path}`} style={styles.evidenceRow}>
            <Icon name={reason ? 'lock' : 'file'} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
            <Text style={styles.evidenceText}>
                {reason === 'invalid_diff' || reason === 'render_failed'
                    ? t('walkthrough.evidence.displayFailed')
                    : reason === 'binary' || !reason
                        ? t('walkthrough.evidence.binary')
                        : t('walkthrough.evidence.unavailable', { reason })}
            </Text>
        </View>
    );
    return (
        <View testID={props.testID ?? `walkthrough-hunk-${file.path}`} style={[styles.card, props.phone ? styles.cardPhone : null]}>
            <ScmChangeRow theme={theme} file={scmFileStatusFromChange(file)} style={styles.cardHeader}
                showChangeMark={false} phone={props.phone} density="compact"
                leadingElement={<FileIcon fileName={fileName(file.path)} size={16} />}
                tag={file.changeKind === 'added' ? t('walkthrough.newFile') : file.changeKind === 'deleted' ? t('walkthrough.deletedFile') : null}
                pathAccessory={file.rangeLabel ? <Text style={styles.range}>{file.rangeLabel}</Text> : null}
                trailingElement={find || props.onOpenFile ? (<>
                    {find ? <ChangedFilesReviewFindCount model={find.model} path={findKey} /> : null}
                    {props.onOpenFile ? <IconButton
                        testID={`walkthrough-open-${file.path}`}
                        variant="plain"
                        iconName="arrow-square-out"
                        iconSize={ICON_SIZE.xs}
                        size={26}
                        accessibilityLabel={t('walkthrough.openInFiles', { file: fileName(file.path) })}
                        onPress={() => props.onOpenFile?.(file.path)}
                    /> : null}
                </>) : null} />
            {file.unifiedDiff ? (
                <View style={bodyStyle}>
                    {/* A reading can hold hundreds of cards: code is drawn as its reserved body nears the viewport, or at once
                        when Find lands on it. Find, counts and the contents read the captured evidence, never the drawn rows. */}
                    <LazyMountOnScreen initiallyVisible={findTargetLineId !== undefined} style={{ minHeight: 'inherit' }}>
                    <HunkEvidenceBoundary key={file.unifiedDiff} fallback={evidence('render_failed')}>
                        <DiffViewer
                            mode="unified"
                            unifiedDiff={file.unifiedDiff}
                            filePath={file.path}
                            showLineNumbers
                            showPrefix
                            wrapLines={props.phone === true}
                            presentationStyleOverride="unified"
                            lineInfoSeparators
                            errorFallback={evidence('render_failed')}
                            findActive={find?.active}
                            precomputedLines={find?.active ? findSnapshot?.lines : undefined}
                            registerFindRefold={find ? registerFindRefold : undefined}
                            findRangesByLineId={findSnapshot?.ranges}
                            scrollToLineId={findTargetLineId}
                            highlightLineId={findTargetLineId}
                            onScrollToLine={findTargetLineId ? find?.onScrollToLine : undefined}
                        />
                    </HunkEvidenceBoundary>
                    </LazyMountOnScreen>
                </View>
            ) : file.deferred && presentation ? (
                presentation.nativeViewport
                    ? <NativeEvidenceFrame path={file.path} present={presentation.present} viewport={presentation.nativeViewport}>
                        {evidence(file.unavailableReason)}
                    </NativeEvidenceFrame>
                    : <LazyMountOnScreen rootMargin="0px" placeholder={evidence(file.unavailableReason)}>
                        {evidence(file.unavailableReason)}
                        <PresentEvidence path={file.path} present={presentation.present} />
                    </LazyMountOnScreen>
            ) : evidence(file.unavailableReason)}
        </View>
    );
});

export type WalkthroughStopSectionProps = Readonly<{
    stop: WalkthroughStop;
    reviewedSource?: WalkthroughReviewedSource;
    current?: boolean;
    phone?: boolean;
    /** Inside a page that has its own title (a Review's Changes): the stop heads a section there, not the page. */
    hosted?: boolean;
    /** The Mark reviewed key, as bound here, on the stop the keyboard acts on; drawn only where that key runs. */
    showKeys?: boolean;
    /** Marking needs the exact code and the person's account; absent hides the control. */
    onToggleReviewed?: (stop: WalkthroughStop) => void;
    marksDisabledReason?: string | null;
    /** Discuss needs a generator that can take a turn; absent hides Ask. */
    onAsk?: (stop: WalkthroughStop, question?: string) => void;
    asking?: boolean;
    onOpenFile?: (path: string) => void;
    /** A review's finding chips, after the prose (lab WT5-R6). */
    findingRefs?: React.ReactNode;
    /** A review's finding cards, beside the hunks they are about (lab WT5-R1). */
    findingCards?: React.ReactNode;
    /** Findings the prose cites inline (lab WT5-R6). */
    proseReferences?: MarkdownInlineReferences;
    /** An explanation asked for explicitly, above the code (lab WT5-R2). */
    explanation?: React.ReactNode;
    /** Find over the whole reading, painted into this stop's code. */
    find?: WalkthroughFindProps | null;
}>;

/** A stop: number, title and reading hint, the prose, then exactly its hunks, then the person's controls. */
export const WalkthroughStopSection = React.memo(function WalkthroughStopSection(props: WalkthroughStopSectionProps) {
    const { theme } = useUnistyles();
    const stop = useWalkthroughReviewedStop(props.reviewedSource, props.stop);
    const importance = props.phone ? null : resolveWalkthroughImportanceLabel(stop);
    const phone = props.phone === true;
    return (
        <View
            testID={`walkthrough-stop-${stop.id}`}
            accessibilityLabel={t('walkthrough.stopA11y', { number: stop.number, title: stop.title })}
            style={[styles.stop, phone ? styles.stopPhone : null]}
        >
            <View style={styles.stopHeader}>
                <View style={props.hosted ? styles.numberSlotSection : styles.numberSlot}>
                    <WalkthroughStopNumber number={stop.number} reviewed={stop.reviewed} current={props.current} size={props.hosted ? 'rail' : 'stream'} />
                </View>
                <Text accessibilityRole="header" style={props.hosted ? styles.stopTitleSection : styles.stopTitle}>{stop.title}</Text>
                {importance ? <Text style={[styles.importance, props.hosted ? styles.importanceSection : null]}>{importance}</Text> : null}
            </View>
            {stop.provenance && (stop.provenance.titleEdited || stop.provenance.changedAtRevision !== undefined || stop.provenance.movedAtRevision !== undefined) ? (
                <Text testID={`walkthrough-provenance-${stop.id}`} style={styles.importance}>
                    {[stop.provenance.titleEdited ? t('walkthrough.progress.titleEdited') : null,
                        stop.provenance.changedAtRevision !== undefined ? t('walkthrough.progress.changed') : null,
                        stop.provenance.movedAtRevision !== undefined ? t('walkthrough.progress.moved') : null].filter(Boolean).join(' · ')}
                </Text>
            ) : null}
            <View style={[styles.indent, phone ? styles.indentPhone : null]}>
                <MarkdownView
                    markdown={stop.explanationMarkdown}
                    textStyle={props.hosted ? styles.proseSection : [styles.prose, phone ? styles.prosePhone : null]}
                    renderCacheKey={`walkthrough-stop:${stop.id}`}
                    inlineReferences={props.proseReferences}
                />
                {props.findingRefs}
                {stop.reviewExplanations?.map((explanation, index) => (
                    <WalkthroughReviewExplanation
                        key={`${explanation.provenance.generatedAtMs}:${index}`}
                        testID={`walkthrough-review-explanation:${stop.id}:${index}`}
                        markdown={explanation.markdown}
                        model={explanation.provenance.modelId ?? t('reviewWalkthrough.explain.unknownModel')}
                        askedAt={formatAsOfTime(explanation.provenance.requestedAtMs)}
                        requester={explanation.provenance.requestedBy.id ?? t(`reviewWalkthrough.explain.requester.${explanation.provenance.requestedBy.kind}`)}
                    />
                ))}
                {props.explanation}
                {stop.files.map((file, index) => (
                    <React.Fragment key={file.path}>
                        {index > 0 ? (
                            <View style={styles.crossFile}>
                                <Icon name="arrow-elbow-down-right" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                                <Text style={styles.crossFileText}>{t('walkthrough.andIn', { file: fileName(file.path) })}</Text>
                            </View>
                        ) : null}
                        <WalkthroughHunkCard file={file} phone={phone} onOpenFile={props.onOpenFile}
                            findKey={walkthroughStopFindKey(stop.id, file.path)} find={props.find} />
                    </React.Fragment>
                ))}
                {props.findingCards}
                <WalkthroughStopExchangeList stopId={stop.id} />
                {!phone && (props.onToggleReviewed || props.onAsk) ? (
                    <View style={styles.footer}>
                        {props.onToggleReviewed ? (
                            <HappierPressable
                                testID={`walkthrough-mark-${stop.id}`}
                                accessibilityRole="button"
                                accessibilityLabel={stop.reviewed ? t('walkthrough.unmarkReviewedA11y') : t('walkthrough.markReviewedA11y')}
                                checked={stop.reviewed}
                                disabled={Boolean(props.marksDisabledReason)}
                                onPress={() => props.onToggleReviewed?.(stop)}
                                style={(state) => [
                                    styles.action,
                                    stop.reviewed ? styles.actionMarked : styles.actionMark,
                                    state.pressed ? styles.actionPressed : null,
                                    props.marksDisabledReason ? styles.actionDisabled : null,
                                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                                ]}
                            >
                                <Icon
                                    name={stop.reviewed ? 'check-circle' : 'circle'}
                                    size={15}
                                    color={stop.reviewed ? theme.colors.state.success.foreground : theme.colors.text.primary}
                                />
                                <Text style={[styles.actionText, stop.reviewed ? styles.actionTextMarked : styles.actionTextStrong]}>
                                    {stop.reviewed ? t('walkthrough.reviewed') : t('walkthrough.markReviewed')}
                                </Text>
                                {props.showKeys && !stop.reviewed ? <KeyboardCommandHint testID={`walkthrough-mark-key-${stop.id}`} commandId="review.change.keep" /> : null}
                            </HappierPressable>
                        ) : null}
                        {props.onAsk ? (
                            <HappierPressable
                                testID={`walkthrough-ask-${stop.id}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('walkthrough.askAboutStopA11y')}
                                onPress={() => props.onAsk?.(stop)}
                                style={(state) => [
                                    styles.action,
                                    props.asking ? styles.actionOn : null,
                                    state.pressed ? styles.actionPressed : null,
                                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                                ]}
                            >
                                <Icon name="chat-circle-dots" size={15} color={theme.colors.text.secondary} />
                                <Text style={styles.actionText}>{t('walkthrough.askAboutThis')}</Text>
                            </HappierPressable>
                        ) : null}
                    </View>
                ) : null}
                {props.onAsk && stop.suggestedQuestions?.length ? (
                    <View testID={`walkthrough-questions-${stop.id}`} style={[styles.questions, phone ? styles.questionsPhone : null]}>
                        {stop.suggestedQuestions.map((question, index) => (
                            <HappierPressable
                                key={`${index}:${question}`}
                                testID={`walkthrough-question-${stop.id}-${index}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('walkthrough.askQuestionA11y', { question })}
                                onPress={() => props.onAsk?.(stop, question)}
                                style={(state) => [
                                    styles.question,
                                    state.pressed ? styles.actionPressed : null,
                                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                                ]}
                            >
                                {/* Plain text: a suggested question is prose the person may choose to ask, never markup. */}
                                <Text style={styles.questionText}>{question}</Text>
                            </HappierPressable>
                        ))}
                    </View>
                ) : null}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    stop: { paddingTop: 26, paddingBottom: theme.space.s8 },
    stopPhone: { paddingTop: theme.space.s20, paddingHorizontal: theme.space.s16 },
    stopHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s10 },
    numberSlot: { paddingTop: theme.space.s2 },
    stopTitle: {
        flex: 1,
        ...Typography.variant('title'),
        color: theme.colors.text.primary,
    },
    // Hosted under a page title, a stop is a section: its title at section scale, its mark the rail's, centred on the line.
    stopTitleSection: {
        flex: 1,
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    numberSlotSection: { paddingTop: (Typography.variant('heading').lineHeight - RAIL_STOP_NUMBER_PX) / 2 },
    // Sits on the stop title's first line.
    importance: { ...Typography.variant('meta'), lineHeight: Typography.variant('title').lineHeight, color: theme.colors.text.tertiary },
    importanceSection: { lineHeight: Typography.variant('heading').lineHeight },
    indent: { marginLeft: theme.space.s32, marginTop: theme.space.s6 },
    indentPhone: { marginLeft: 0 },
    prose: { fontSize: 15, lineHeight: 23, color: theme.colors.text.primary },
    prosePhone: { fontSize: 16, lineHeight: 24 },
    // Under a section-scale title the prose reads at the page's reading size, a step below its heading.
    proseSection: { ...Typography.variant('reading'), color: theme.colors.text.primary },
    card: {
        marginTop: theme.space.s10,
        marginBottom: theme.space.s2,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    cardPhone: { marginHorizontal: -16, borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0 },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 36,
        paddingLeft: theme.space.s12,
        paddingRight: theme.space.s6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    range: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'],  },
    evidenceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8, padding: theme.space.s12 },
    evidenceText: { flex: 1, ...Typography.variant('body'),  color: theme.colors.text.secondary,  },
    crossFile: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, marginTop: theme.space.s10 },
    crossFileText: { ...Typography.variant('meta'), color: theme.colors.text.tertiary,  },
    footer: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, marginTop: theme.space.s12, marginBottom: theme.space.s6 },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        height: 30,
        paddingLeft: theme.space.s8,
        paddingRight: theme.space.s10,
        borderRadius: 8,
    },
    actionMark: { borderWidth: 1, borderColor: theme.colors.border.strong },
    actionMarked: { paddingLeft: theme.space.s6 },
    actionOn: { backgroundColor: theme.colors.surface.selected },
    actionPressed: { backgroundColor: theme.colors.surface.pressed },
    actionDisabled: { opacity: 0.5 },
    actionText: { ...Typography.variant('body', 'medium'), color: theme.colors.text.secondary,  },
    actionTextStrong: { color: theme.colors.text.primary },
    actionTextMarked: { color: theme.colors.state.success.textForeground, ...Typography.default('semiBold') },
    // Questions sit under the stop's Ask, in its rhythm: quiet ink-edged controls that wrap, never a second toolbar.
    questions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s6, marginTop: theme.space.s2, marginBottom: theme.space.s6 },
    questionsPhone: { marginTop: theme.space.s12 },
    question: {
        maxWidth: '100%',
        minHeight: 30,
        justifyContent: 'center',
        paddingVertical: theme.space.s4,
        paddingHorizontal: theme.space.s10,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    questionText: { ...Typography.variant('body'), color: theme.colors.text.secondary },
}));
