import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { ReviewFindingLine, ReviewSeverityLabel } from '@/components/sessions/reviews/findings/ReviewSeverity';
import { StructuredFindText } from '@/components/sessions/transcript/structured/structuredFindText';
import { useReviewSeverityColors } from '@/components/sessions/reviews/findings/useReviewSeverityColors';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { WalkthroughFindingTailEntry, WalkthroughFindingView, WalkthroughReviewSummary } from './reviewWalkthroughOverlay';
import type { ReviewWalkthroughProgress } from './reviewWalkthroughProgress';

/**
 * The pieces a review brings into a walkthrough (Walkthrough lab WT5). Four things can sit beside the
 * same code and each looks different: explanation is prose, a finding is a card with a severity rail,
 * a comment keeps its own card, a reviewed mark is the green check. Severity colour appears only here.
 */
/** A finding named in the prose: severity and engine, scrolling to its card (lab WT5-R6). */
export function ReviewFindingReference(props: Readonly<{ view: WalkthroughFindingView; onPress?: (view: WalkthroughFindingView) => void }>) {
    const { theme } = useUnistyles();
    const colors = useReviewSeverityColors(props.view.severity);
    const label = `${reviewSeverityLabel(props.view.severity)} · ${props.view.engineLabel}`;
    return (
        <HappierPressable
            testID={`walkthrough-finding-ref-${props.view.findingId}`}
            accessibilityRole="link"
            accessibilityLabel={t('reviewWalkthrough.findingRefA11y', { label, title: props.view.finding.title })}
            onPress={() => props.onPress?.(props.view)}
            style={(state) => [styles.ref, { backgroundColor: colors.tint }, state.pressed ? styles.pressed : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <View style={[styles.dot, { backgroundColor: colors.foreground }]} />
            <Text style={[styles.refText, { color: colors.textForeground }]}>{label}</Text>
        </HappierPressable>
    );
}

/** The chips a stop's prose names, as one line after the explanation. */
export function ReviewFindingReferences(props: Readonly<{ views: readonly WalkthroughFindingView[]; onPress?: (view: WalkthroughFindingView) => void }>) {
    if (props.views.length === 0) return null;
    return (
        <View style={styles.refs}>
            {props.views.map((view) => <ReviewFindingReference key={view.key} view={view} onPress={props.onPress} />)}
        </View>
    );
}

/**
 * A finding beside the code it is about: a card with its severity rail, what it is, who found it and
 * where, then its triage and Ask. `tag` names why a tail entry has no stop ("No file", "Outdated").
 */
export const WalkthroughFindingCard = React.memo(function WalkthroughFindingCard(props: Readonly<{
    view: WalkthroughFindingView;
    tag?: WalkthroughFindingTailEntry['tag'] | null;
    phone?: boolean;
    /** The triage control, wired to the finding's durable review comment by the caller. */
    triage?: React.ReactNode;
    onAsk?: (() => void) | null;
    showAskKey?: boolean;
}>) {
    const { theme } = useUnistyles();
    const view = props.view;
    const colors = useReviewSeverityColors(view.severity);
    const fileName = view.location ? view.location.slice(view.location.lastIndexOf('/') + 1) : null;
    const meta = [view.finding.category, view.engineLabel, props.tag === 'no_file' ? null : fileName].filter(Boolean).join(' · ');
    const tagLabel = props.tag === 'no_file' ? t('reviewWalkthrough.tag.noFile')
        : props.tag === 'outdated' ? t('reviewWalkthrough.tag.outdated')
            : props.tag === 'unplaced' ? t('reviewWalkthrough.tag.unplaced')
                : props.tag === 'not_in_story' ? t('reviewWalkthrough.tag.notInStory') : null;
    return (
        <View testID={`walkthrough-finding-${view.findingId}`} style={[styles.card, props.phone ? styles.cardPhone : null]}>
            <View style={[styles.rail, { backgroundColor: colors.foreground }]} />
            <View style={styles.cardBody}>
                <View style={styles.cardHead}>
                    <ReviewSeverityLabel severity={view.severity} />
                    <Text style={styles.cardMeta} numberOfLines={1}>{meta}</Text>
                    <View style={styles.grow} />
                    {tagLabel ? <StatusPill variant="neutral" label={tagLabel} labelVariant="phrase" hideDot /> : null}
                </View>
                <Text selectable style={styles.cardTitle}>{view.finding.title}</Text>
                {props.tag === 'outdated'
                    ? <Text style={styles.cardSummary}>{t('reviewWalkthrough.outdatedSummary')}</Text>
                    : <MarkdownView markdown={view.finding.summary} textStyle={styles.cardSummary} renderCacheKey={`walkthrough-finding:${view.key}`} />}
                {props.triage || props.onAsk ? (
                    <View style={styles.cardFoot}>
                        {props.triage}
                        <View style={styles.grow} />
                        {props.onAsk ? (
                            <HappierPressable
                                testID={`walkthrough-finding-ask-${view.findingId}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('reviewWalkthrough.askAboutFindingA11y', { title: view.finding.title })}
                                onPress={props.onAsk}
                                style={(state) => [styles.ask, state.pressed ? styles.pressed : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                            >
                                <Text style={styles.askText}>{t('walkthrough.askAboutThis')}</Text>
                                {props.showAskKey ? <KeyHint label="/" /> : null}
                            </HappierPressable>
                        ) : null}
                    </View>
                ) : null}
            </View>
        </View>
    );
});

/** Findings that no stop explains close the stream, so nothing disappears (lab WT5-R3). */
export function WalkthroughFindingsTail(props: Readonly<{
    entries: readonly WalkthroughFindingTailEntry[];
    phone?: boolean;
    renderTriage?: (view: WalkthroughFindingView) => React.ReactNode;
}>) {
    if (props.entries.length === 0) return null;
    return (
        <View testID="walkthrough-findings-tail" style={[styles.tail, props.phone ? styles.tailPhone : null]}>
            <Text accessibilityRole="header" style={styles.tailTitle}>
                {t('reviewWalkthrough.tailTitle')}
                <Text style={styles.tailCount}>{` ${props.entries.length}`}</Text>
            </Text>
            {props.phone ? null : <Text style={styles.tailDescription}>{t('reviewWalkthrough.tailDescription')}</Text>}
            <View style={[styles.tailCards, props.phone ? null : styles.tailCardsIndent]}>
                {props.entries.map((entry) => (
                    <WalkthroughFindingCard key={entry.key} view={entry} tag={entry.tag} phone={props.phone} triage={props.renderTriage?.(entry)} />
                ))}
            </View>
        </View>
    );
}

/**
 * The header's review line: how many findings and where they sit, or how far the review got. A review
 * that is still running or stopped partway never reads as a clean one.
 */
export function WalkthroughReviewFact(props: Readonly<{
    summary: WalkthroughReviewSummary;
    /** After-the-fact: the findings were in the narrator's context, or came from a review at this time. */
    variant?: Readonly<{ kind: 'in_context' }> | Readonly<{ kind: 'from_review'; at: string }> | null;
}>) {
    const { theme } = useUnistyles();
    const s = props.summary;
    const partial = s.state === 'partial';
    const warning = partial || s.state === 'unavailable';
    const strong = (value: string) => <Text style={styles.factStrong}>{value}</Text>;
    let body: React.ReactNode;
    if (s.state === 'unavailable' || s.state === 'loading') {
        body = <>{t(s.state === 'loading' ? 'common.loading' : 'common.requestFailed')}</>;
    } else if (props.variant?.kind === 'in_context') {
        body = <>{strong(t('runPage.review.findingTotal', { count: s.total }))}{` ${t('reviewWalkthrough.inContext')}`}</>;
    } else if (props.variant?.kind === 'from_review') {
        body = <>{strong(t('runPage.review.findingTotal', { count: s.total }))}{` ${t('reviewWalkthrough.fromReviewAt', { time: props.variant.at })}`}</>;
    } else if (partial) {
        body = <>{`${t('reviewWalkthrough.reviewLabel')} `}{strong(t('reviewWalkthrough.enginesOf', { count: s.finishedEngines, total: s.totalEngines }))}{` ${t('reviewWalkthrough.enginesFinished', { count: s.totalEngines })}`}</>;
    } else {
        const detail = s.state === 'running'
            ? t('reviewWalkthrough.enginesRunning', { count: s.runningEngines })
            : s.engineLabels.length > 1 && s.elsewhere === 0
                ? t('reviewWalkthrough.fromEngines', { engines: s.engineLabels.join(t('reviewWalkthrough.and')), inStory: s.inStory })
                : s.elsewhere > 0
                    ? t('reviewWalkthrough.inStoryElsewhere', { inStory: s.inStory, elsewhere: s.elsewhere })
                    : t('reviewWalkthrough.allInStory');
        // At zero there is no story placement to report: a finished clean review says so in one phrase.
        body = s.state === 'running' && s.total === 0
            ? <>{`${t('reviewWalkthrough.reviewLabel')} `}{strong(detail)}</>
            : s.total === 0
                ? <>{`${t('reviewWalkthrough.reviewLabel')} `}{strong(t('reviewWalkthrough.noFindings'))}</>
            : <>{`${t('reviewWalkthrough.reviewLabel')} `}{strong(t('runPage.review.findingTotal', { count: s.total }))}{` · ${detail}`}</>;
    }
    return (
        <View testID="walkthrough-review-fact" style={styles.fact}>
            <Icon name={s.state === 'loading' ? 'circle' : warning ? 'warning' : 'shield-check'} size={13} color={warning ? theme.colors.state.warning.foreground : theme.colors.text.tertiary} />
            <Text style={styles.factText}>{body}</Text>
        </View>
    );
}

/**
 * An explanation of the findings, asked for explicitly (lab WT5-R2): the model's own words above the
 * code, labelled as an explanation and not a verdict, so it never reads as the finding or the stop.
 */
export function WalkthroughReviewExplanation(props: Readonly<{ markdown: string; model: string; askedAt: string; requester?: string; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <View testID={props.testID ?? 'walkthrough-review-explanation'} style={styles.explanation}>
            <View style={styles.explanationHead}>
                <Icon name="sparkle" size={12} color={theme.colors.text.tertiary} />
                <Text style={styles.explanationLabel}>{t('reviewWalkthrough.explain.header', { model: props.model, time: props.askedAt, requester: props.requester })}</Text>
            </View>
            <MarkdownView markdown={props.markdown} textStyle={styles.explanationText} renderCacheKey={`walkthrough-explanation:${props.askedAt}`} />
        </View>
    );
}

/** The narrator's honest note when a new run wrote it after the review (lab WT5-R9 B). */
export function WalkthroughSeededNote(props: Readonly<{ reviewers: string; at: string; changedFiles: number }>) {
    const { theme } = useUnistyles();
    return (
        <View testID="walkthrough-seeded-note" style={styles.note}>
            <Icon name="info" size={ICON_SIZE.sm} color={theme.colors.text.tertiary} />
            <Text style={styles.noteText}>
                <Text style={styles.noteStrong}>{t('reviewWalkthrough.seeded.title')}</Text>
                {` ${t('reviewWalkthrough.seeded.body', { reviewers: props.reviewers, time: props.at })}`}
                {props.changedFiles > 0 ? <Text style={styles.noteWarn}>{` ${t('reviewWalkthrough.seeded.changed', { count: props.changedFiles })}`}</Text> : null}
            </Text>
        </View>
    );
}

/** The findings, published first and usable at once, while the walkthrough is written (lab WT5-R5). */
export function ReviewFindingsFirst(props: Readonly<{
    views: readonly WalkthroughFindingView[];
    publishedAt: string | null;
    /** "3 findings from CodeRabbit" when one findings-only engine reviewed. */
    engineLabel?: string | null;
    phone?: boolean;
    onPressFinding?: (view: WalkthroughFindingView) => void;
}>) {
    const { theme } = useUnistyles();
    const count = props.views.length;
    return (
        <View testID="walkthrough-findings-first" style={[styles.first, props.phone ? styles.firstPhone : null]}>
            <View style={styles.firstHead}>
                <Icon name="shield-check" size={14} color={theme.colors.text.secondary} />
                <Text style={styles.firstTitle}>
                    {props.engineLabel ? t('reviewWalkthrough.findingsFrom', { count, engine: props.engineLabel }) : t('runPage.review.findingTotal', { count })}
                </Text>
                {props.publishedAt ? <Text style={styles.firstMeta} numberOfLines={1}>{`· ${t('reviewWalkthrough.publishedBefore', { time: props.publishedAt })}`}</Text> : null}
            </View>
            {props.views.map((view) => (
                <ReviewFindingLine
                    key={view.key}
                    severity={view.severity}
                    title={view.finding.title}
                    reviewer={view.engineLabel}
                    onPress={props.onPressFinding ? () => props.onPressFinding?.(view) : undefined}
                />
            ))}
        </View>
    );
}

/**
 * One review operation as one status in the bar, two named steps (lab WT5-R5, R9): Reviewing, then
 * Writing walkthrough. Each step's state comes from its own owner.
 */
export function ReviewWalkthroughSteps(props: Readonly<{ progress: ReviewWalkthroughProgress; phone?: boolean }>) {
    const { theme } = useUnistyles();
    const review = props.progress.review;
    const narration = props.progress.narration;
    const reviewLabel = reviewStepLabel(review, props.phone === true);
    const narrationLabel = !narration ? null
        : narration.kind === 'ready' ? t('reviewWalkthrough.steps.readyShort')
            : narration.kind === 'failed' ? t('reviewWalkthrough.steps.failed')
                : narration.kind === 'narrating' ? t('reviewWalkthrough.steps.narrating')
                    : narration.kind === 'narrator_writing' ? t('reviewWalkthrough.steps.narratorWriting', { narrator: narration.narrator })
                        : props.phone ? t('reviewWalkthrough.steps.writingShort') : t('reviewWalkthrough.steps.writing');
    const a11y = narrationLabel ? `${reviewLabel}, ${narrationLabel}` : reviewLabel;
    return (
        <View testID="review-walkthrough-steps" accessibilityRole="progressbar" accessibilityLabel={a11y} accessibilityLiveRegion="polite"
            style={[styles.steps, props.phone ? styles.stepsPhone : null]}>
            {props.phone ? null : <Icon name="shield-check" size={14} color={theme.colors.text.secondary} />}
            <Step state={review.state} label={reviewLabel} />
            {narrationLabel && narration ? (
                <>
                    <Icon name="caret-right" size={11} color={theme.colors.text.tertiary} />
                    <Step state={narration.state} label={narrationLabel} />
                </>
            ) : null}
        </View>
    );
}

function reviewStepLabel(review: ReviewWalkthroughProgress['review'], phone: boolean): string {
    switch (review.kind) {
        case 'reviewing': return t('reviewWalkthrough.steps.reviewing');
        case 'engines_reviewing': return t('reviewWalkthrough.steps.engineProgress', {
            done: review.done.join(t('reviewWalkthrough.and')), running: review.running.join(t('reviewWalkthrough.and')),
        });
        case 'reviewed': return phone ? t('reviewWalkthrough.steps.reviewedShort', { count: review.findings }) : t('reviewWalkthrough.steps.reviewed', { count: review.findings });
        case 'engine_reviewed': return t('reviewWalkthrough.steps.engineReviewed', { engine: review.engine, count: review.findings });
        case 'reviewed_at': return t('reviewWalkthrough.steps.reviewedAt', { time: review.at });
        case 'review_at': return t('reviewWalkthrough.steps.reviewAt', { time: review.at });
        case 'partial': return t('reviewWalkthrough.steps.partial', { count: review.findings });
        case 'loading': return t('common.loading');
        case 'unavailable': return t('common.requestFailed');
    }
}

function Step(props: Readonly<{ state: 'waiting' | 'running' | 'done' | 'partial' | 'failed'; label: string }>) {
    const { theme } = useUnistyles();
    const glyph = props.state === 'done' ? <Icon name="check" size={12} color={theme.colors.state.success.foreground} />
        : props.state === 'partial' ? <Icon name="warning" size={12} color={theme.colors.state.warning.foreground} />
            : props.state === 'failed' ? <Icon name="x-circle" size={12} color={theme.colors.state.danger.foreground} />
                : props.state === 'running' ? <ActivitySpinner size={12} color={theme.colors.text.primary} />
                    : <View style={styles.waitingRing} />;
    return (
        <View style={styles.step}>
            {glyph}
            <Text numberOfLines={1} style={[styles.stepText, props.state === 'running' ? styles.stepTextActive : null]}>{props.label}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    grow: { flex: 1 },
    pressed: { opacity: 0.7 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    refs: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s6, marginTop: theme.space.s6 },
    ref: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, paddingHorizontal: theme.space.s8, paddingVertical: 3, borderRadius: 7 },
    refText: { ...Typography.variant('body', 'semiBold'),  },
    card: {
        flexDirection: 'row',
        marginTop: theme.space.s12,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    cardPhone: { marginTop: 14 },
    rail: { width: 3 },
    cardBody: { flex: 1, minWidth: 0, paddingVertical: theme.space.s12, paddingLeft: 14, paddingRight: 14, gap: theme.space.s4 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    cardMeta: { flexShrink: 1, ...Typography.variant('body'), color: theme.colors.text.secondary,  },
    cardTitle: { marginTop: theme.space.s2, ...Typography.variant('label', 'semiBold'),  color: theme.colors.text.primary,  },
    cardSummary: { fontSize: 14, lineHeight: 20, color: theme.colors.text.secondary, ...Typography.default() },
    cardFoot: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s10, marginTop: theme.space.s8 },
    ask: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, minHeight: 32, paddingHorizontal: theme.space.s4 },
    askText: { ...Typography.variant('body'), color: theme.colors.text.tertiary,  },
    tail: { marginTop: 28, paddingTop: 22, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    tailPhone: { marginTop: theme.space.s12, paddingTop: theme.space.s16, paddingHorizontal: theme.space.s16, borderTopWidth: 0 },
    tailTitle: { ...Typography.variant('heading'), lineHeight: 24, color: theme.colors.text.primary,  },
    tailCount: { color: theme.colors.text.tertiary, ...Typography.default('medium') },
    tailDescription: { marginTop: theme.space.s2, fontSize: 14, lineHeight: 20, color: theme.colors.text.secondary, ...Typography.default() },
    tailCards: { marginTop: theme.space.s4 },
    tailCardsIndent: { marginLeft: theme.space.s32 },
    fact: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
    factText: { ...Typography.variant('body'), color: theme.colors.text.secondary, fontVariant: ['tabular-nums'],  },
    factStrong: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
    explanation: {
        marginTop: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
        gap: theme.space.s6,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.inset,
    },
    explanationHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
    explanationLabel: { flexShrink: 1, ...Typography.variant('body'), color: theme.colors.text.tertiary,  },
    explanationText: { fontSize: 15, lineHeight: 22, color: theme.colors.text.primary },
    note: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
        marginTop: theme.space.s16,
        padding: 14,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    noteText: { flex: 1, fontSize: 14, lineHeight: 20, color: theme.colors.text.secondary, ...Typography.default() },
    noteStrong: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
    noteWarn: { color: theme.colors.text.secondary },
    first: {
        marginTop: theme.space.s20,
        paddingVertical: theme.space.s10,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    firstPhone: { marginHorizontal: theme.space.s16, marginTop: 14 },
    firstHead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, paddingVertical: theme.space.s4 },
    firstTitle: { flexShrink: 0, ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary,  },
    firstMeta: { flexShrink: 1, ...Typography.variant('body'), color: theme.colors.text.tertiary,  },
    steps: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        height: 36,
        paddingHorizontal: theme.space.s10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    stepsPhone: { justifyContent: 'center', height: 44, borderRadius: 12 },
    step: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, flexShrink: 1 },
    // The bar's status reads at the bar's own text role, so it sits beside Propose commits as one row (WT5-R6).
    stepText: { ...Typography.variant('body'), color: theme.colors.text.secondary },
    stepTextActive: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
    waitingRing: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: theme.colors.text.tertiary },
}));
