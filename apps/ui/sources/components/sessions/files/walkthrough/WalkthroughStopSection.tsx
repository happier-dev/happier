import * as React from 'react';
import { View, Platform, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { MarkdownView, type MarkdownInlineReferences } from '@/components/markdown/MarkdownView';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { CODE_LINE_BASE_HEIGHT } from '@/components/ui/code/view/CodeLineRow';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { HAPPIER_UI_FONT_SCALE_CSS_VAR } from '@/components/ui/text/webUnistylesFontOverrides';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WalkthroughReviewExplanation } from '@/components/sessions/reviews/walkthrough/ReviewWalkthroughParts';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { WalkthroughLineCounts, WalkthroughPath, WalkthroughStopNumber } from './WalkthroughAtoms';
import type { WalkthroughStop, WalkthroughStopFile } from './walkthroughReading';

function fileName(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}

class HunkEvidenceBoundary extends React.Component<Readonly<{ children: React.ReactNode; fallback: React.ReactNode }>, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** The reading hint beside a stop's title: where to read, never a verdict (lab WT1-A). */
export function resolveWalkthroughImportanceLabel(stop: Pick<WalkthroughStop, 'number' | 'importance'>): string | null {
    if (stop.number === 1 && stop.importance !== 'low') return t('walkthrough.importance.start');
    if (stop.importance === 'high') return t('walkthrough.importance.high');
    if (stop.importance === 'low') return t('walkthrough.importance.low');
    return null;
}

/** One file's exact hunks for a stop, as a quiet card: path, range, counts and the shared diff renderer. */
export const WalkthroughHunkCard = React.memo(function WalkthroughHunkCard(props: Readonly<{
    file: WalkthroughStopFile;
    phone?: boolean;
    onOpenFile?: (path: string) => void;
}>) {
    const { theme } = useUnistyles();
    const file = props.file;
    const rows = React.useMemo(() => file.unifiedDiff ? buildCodeLinesFromUnifiedDiff({ unifiedDiff: file.unifiedDiff }).length : 0, [file.unifiedDiff]);
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
        <View testID={`walkthrough-hunk-${file.path}`} style={[styles.card, props.phone ? styles.cardPhone : null]}>
            <View style={styles.cardHeader}>
                <FileIcon fileName={fileName(file.path)} size={16} />
                {props.phone ? <Text style={styles.phoneFileName} numberOfLines={1}>{fileName(file.path)}</Text> : <WalkthroughPath path={file.path} />}
                <View style={styles.grow} />
                {file.changeKind === 'added' ? <Text style={styles.newFile}>{t('walkthrough.newFile')}</Text> : null}
                {file.changeKind === 'deleted' ? <Text style={styles.deletedFile}>{t('walkthrough.deletedFile')}</Text> : null}
                {file.rangeLabel ? <Text style={styles.range}>{file.rangeLabel}</Text> : null}
                <WalkthroughLineCounts added={file.added} removed={file.removed} />
                {props.onOpenFile ? (
                    <IconButton
                        testID={`walkthrough-open-${file.path}`}
                        variant="plain"
                        iconName="arrow-square-out"
                        iconSize={ICON_SIZE.xs}
                        size={26}
                        accessibilityLabel={t('walkthrough.openInFiles', { file: fileName(file.path) })}
                        onPress={() => props.onOpenFile?.(file.path)}
                    />
                ) : null}
            </View>
            {file.unifiedDiff ? (
                <View style={bodyStyle}>
                    <HunkEvidenceBoundary key={file.unifiedDiff} fallback={evidence('render_failed')}>
                        <DiffViewer
                            mode="unified"
                            unifiedDiff={file.unifiedDiff}
                            filePath={file.path}
                            showLineNumbers
                            showPrefix
                            wrapLines={props.phone === true}
                            presentationStyleOverride="unified"
                            errorFallback={evidence('render_failed')}
                        />
                    </HunkEvidenceBoundary>
                </View>
            ) : (
                evidence(file.unavailableReason)
            )}
        </View>
    );
});

export type WalkthroughStopSectionProps = Readonly<{
    stop: WalkthroughStop;
    current?: boolean;
    phone?: boolean;
    /** The R key hint beside Mark reviewed, on the stop the keyboard acts on (web). */
    showKeys?: boolean;
    /** Marking needs the exact code and the person's account; absent hides the control. */
    onToggleReviewed?: (stop: WalkthroughStop) => void;
    marksDisabledReason?: string | null;
    /** Discuss needs a generator that can take a turn; absent hides Ask. */
    onAsk?: (stop: WalkthroughStop) => void;
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
}>;

/** A stop: number, title and reading hint, the prose, then exactly its hunks, then the person's controls. */
export const WalkthroughStopSection = React.memo(function WalkthroughStopSection(props: WalkthroughStopSectionProps) {
    const { theme } = useUnistyles();
    const stop = props.stop;
    const importance = props.phone ? null : resolveWalkthroughImportanceLabel(stop);
    const phone = props.phone === true;
    return (
        <View
            testID={`walkthrough-stop-${stop.id}`}
            accessibilityLabel={t('walkthrough.stopA11y', { number: stop.number, title: stop.title })}
            style={[styles.stop, phone ? styles.stopPhone : null]}
        >
            <View style={styles.stopHeader}>
                <View style={styles.numberSlot}><WalkthroughStopNumber number={stop.number} reviewed={stop.reviewed} current={props.current} /></View>
                <Text accessibilityRole="header" style={[styles.stopTitle, phone ? styles.stopTitlePhone : null]}>{stop.title}</Text>
                {importance ? <Text style={styles.importance}>{importance}</Text> : null}
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
                    textStyle={[styles.prose, phone ? styles.prosePhone : null]}
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
                        <WalkthroughHunkCard file={file} phone={phone} onOpenFile={props.onOpenFile} />
                    </React.Fragment>
                ))}
                {props.findingCards}
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
                                {props.showKeys && !stop.reviewed ? <KeyHint label="R" /> : null}
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
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    stop: { paddingTop: 26, paddingBottom: 8 },
    stopPhone: { paddingTop: 20, paddingHorizontal: 16 },
    stopHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    numberSlot: { paddingTop: 2 },
    stopTitle: {
        flex: 1,
        fontSize: 18,
        lineHeight: 25,
        letterSpacing: -0.25,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    stopTitlePhone: { fontSize: 19, lineHeight: 25 },
    importance: { fontSize: 12, lineHeight: 25, color: theme.colors.text.tertiary, ...Typography.default() },
    indent: { marginLeft: 32, marginTop: 6 },
    indentPhone: { marginLeft: 0 },
    prose: { fontSize: 15, lineHeight: 23, color: theme.colors.text.primary },
    prosePhone: { fontSize: 16, lineHeight: 24 },
    card: {
        marginTop: 10,
        marginBottom: 2,
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
        gap: 8,
        minHeight: 36,
        paddingLeft: 12,
        paddingRight: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    phoneFileName: { fontSize: 13, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    grow: { flex: 1 },
    newFile: { fontSize: 12, color: theme.colors.state.success.foreground, ...Typography.default('semiBold') },
    deletedFile: { fontSize: 12, color: theme.colors.state.danger.foreground, ...Typography.default('semiBold') },
    range: { fontSize: 12, color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'], ...Typography.default() },
    evidenceRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12 },
    evidenceText: { flex: 1, fontSize: 13, lineHeight: 19, color: theme.colors.text.secondary, ...Typography.default() },
    crossFile: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
    crossFileText: { fontSize: 12, color: theme.colors.text.tertiary, ...Typography.default() },
    footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, marginBottom: 6 },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 30,
        paddingLeft: 8,
        paddingRight: 10,
        borderRadius: 8,
    },
    actionMark: { borderWidth: 1, borderColor: theme.colors.border.strong },
    actionMarked: { paddingLeft: 6 },
    actionOn: { backgroundColor: theme.colors.surface.selected },
    actionPressed: { backgroundColor: theme.colors.surface.pressed },
    actionDisabled: { opacity: 0.5 },
    actionText: { fontSize: 13, color: theme.colors.text.secondary, ...Typography.default('medium') },
    actionTextStrong: { color: theme.colors.text.primary },
    actionTextMarked: { color: theme.colors.state.success.foreground, ...Typography.default('semiBold') },
}));
