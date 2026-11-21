import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import { HappierReviewFinding } from '@happier-dev/plugin-ui';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { Typography } from '@/constants/Typography';
import { t, usePreferredLanguage } from '@/text';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ReviewFindingBody, type ReviewFindingReviewer } from '@/components/reviews/finding/ReviewFindingBody';
import {
    ReviewFindingThread,
    ReviewFindingThreadEntries,
    ReviewFindingCommentReply,
    type ReviewFindingAskContext,
    type ReviewFindingThreadEntryView,
} from '@/components/sessions/reviews/findings/ReviewFindingThread';
import type { ReviewFollowUpAvailability } from '@/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { formatReviewFindingLocation, reviewSeverityLabel } from '@/components/sessions/reviews/findings/reviewFindingPresentation';
import { REVIEW_SEVERITY_COLUMN_WIDTH_PX, ReviewSeverityLabel } from '@/components/sessions/reviews/findings/ReviewSeverity';
import { StructuredFindText } from '@/components/sessions/transcript/structured/structuredFindText';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type ReviewFindingDecision = 'accept' | 'reject' | 'defer';
export const REVIEW_FINDING_DECISIONS: readonly ReviewFindingDecision[] = ['accept', 'reject', 'defer'];

/**
 * How much of a finding a presentation shows (lab R2): `page` is the result page (description
 * shown, one per row); `card` is the transcript card (title and place only).
 */
export type ReviewFindingRowDensity = 'page' | 'card';

/** The shipped decision words (Pending, Implement fix, Ignore, Decide later), one owner for every surface. */
export function reviewFindingDecisionLabel(decision: ReviewFindingDecision | 'undecided'): string {
    switch (decision) {
        case 'undecided': return t('session.reviewFindings.status.untriaged');
        case 'accept': return t('session.reviewFindings.status.accept');
        case 'reject': return t('session.reviewFindings.status.reject');
        case 'defer': return t('session.reviewFindings.status.defer');
    }
}

/** Accept · Defer · Reject: the one triage control wherever a finding is decided (transcript, Run page, walkthrough). */
export const ReviewFindingDecisionControl = React.memo(function ReviewFindingDecisionControl(props: Readonly<{
    testIDPrefix: string;
    decision: ReviewFindingDecision | 'undecided';
    disabled: boolean;
    onDecide: (decision: ReviewFindingDecision) => void;
}>) {
    const language = usePreferredLanguage();
    const tabs = React.useMemo(() => REVIEW_FINDING_DECISIONS.map((decision) => ({ id: decision, label: reviewFindingDecisionLabel(decision) })), [language]);
    return (
        <SegmentedTabBar<ReviewFindingDecision>
            role="radiogroup"
            tabs={tabs}
            activeTabId={props.decision as ReviewFindingDecision}
            onSelectTab={props.onDecide}
            disabled={props.disabled}
            compact
            segmentSizing="content"
            accessibilityLabel={t('runPage.review.triageLabel')}
            testIDPrefix={props.testIDPrefix}
        />
    );
});

function ReviewFindingTaskProjectionDemand({ scope }: Readonly<{ scope: ServerAccountScope }>) {
    // The selected-origin demand reads the active Home's Machine candidates.
    const isActiveScope = useAppShellPluginUiProjection(value => areServerAccountScopesEqual(value.accountLifetime?.scope, scope));
    return isActiveScope ? <PluginSurfaceProjectionDemand pluginId={TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1} accountScope={scope} /> : null;
}

/** One finding: severity, what and where, what changed after a question, your decision, its thread. */
export const ReviewFindingRow = React.memo(function ReviewFindingRow(props: Readonly<{
    /** The row's id within its review: what its controls and callbacks are keyed by. */
    rowId: string;
    finding: ReviewFinding;
    currentBodyMarkdown?: string;
    reviewContext?: React.ComponentProps<typeof ReviewFindingBody>['reviewContext'];
    seenBefore?: React.ComponentProps<typeof ReviewFindingBody>['seenBefore'];
    /** Who found it, when the review has several reviewers ("Sonnet 5", "Both"); `null` for one. */
    attribution: Readonly<{ label: string; backendIds: readonly string[] }> | null;
    /** Every reviewer that reported it, first reporter first: the opened finding's conversation names them. */
    reviewers: readonly ReviewFindingReviewer[];
    /** The finding as first reported, when a reviewer's answer changed it. */
    original: ReviewFinding | null;
    density: ReviewFindingRowDensity;
    findBlockPrefix?: string;
    divided: boolean;
    /** `null` hides an unavailable decision; editability is separate from its persisted value. */
    decision: ReviewFindingDecision | 'undecided' | null;
    /** Read-only recipients retain the decision without its editing controls. */
    decisionEditable?: boolean;
    /** What became of the finding once it was settled ("Fixed in a5c09e2"); it replaces the decision word. */
    resolution?: string | null;
    /** The decision can't be recorded yet (its comment is loading or missing). */
    decisionDisabled: boolean;
    /** Why a decision can't be recorded, shown under the control. */
    decisionNote: string | null;
    onDecide: (findingId: string, decision: ReviewFindingDecision) => void;
    /** `null` hides Ask about this (a read-only transcript). */
    followUp: ReviewFollowUpAvailability | null;
    threadEntries: readonly ReviewFindingThreadEntryView[];
    pendingQuestion: string | null;
    /** `page`: the finding is opened (merged B). `card`: its thread is open under it. */
    expanded: boolean;
    onToggleExpanded: (rowId: string) => void;
    /** Who a question goes to and where it is composed. */
    askContext: ReviewFindingAskContext | null;
    onAsk: (rowId: string, messageMarkdown: string) => Promise<boolean>;
    /** Opens the existing Tasks draft for this saved canonical finding. */
    onCreateTask?: (rowId: string) => Promise<void>;
    taskScope?: ServerAccountScope | null;
    /** The finding's standing words from their owners (round status, already there), after who found it. */
    facts?: readonly string[];
    /** Page rows in bulk selection: the row is the checkbox, its check in the decision glyph's place. */
    selection?: Readonly<{ selected: boolean; onToggle: (rowId: string) => void; disabled?: boolean }>;
}>) {
    const { theme } = useUnistyles();
    const { finding, rowId, onAsk, onDecide, onToggleExpanded } = props;
    const location = formatReviewFindingLocation(finding);
    const replyCount = props.threadEntries.length;
    const askDisabled = props.followUp !== null && !props.followUp.available;
    const ask = React.useCallback((message: string) => onAsk(rowId, message), [onAsk, rowId]);
    const decide = React.useCallback((next: ReviewFindingDecision) => onDecide(rowId, next), [onDecide, rowId]);

    const decisionControl = props.decision !== null && props.decisionEditable !== false ? (
        <View style={props.density === 'card' ? styles.decisionAside : styles.decisionOpened}>
            <ReviewFindingDecisionControl
                testIDPrefix={`review-finding-triage:${rowId}`}
                decision={props.decision}
                disabled={props.decisionDisabled}
                onDecide={decide}
            />
        </View>
    ) : null;
    const taskControl = props.onCreateTask ? (
        <>
            {props.taskScope ? <ReviewFindingTaskProjectionDemand scope={props.taskScope} /> : null}
            <TextLinkButton testID={`review-finding-task:${rowId}`} label={t('runPage.review.createTask')}
                size="meta" onPress={() => props.onCreateTask?.(rowId)} />
        </>
    ) : null;

    if (props.density === 'page') {
        // The opened page row keeps its rare actions (Create task) behind one "…" beside the decision control,
        // never in the body under the conversation (lab `detail-finding`).
        const onCreateTask = props.onCreateTask;
        const actions = onCreateTask ? (
            <>
                {props.taskScope ? <ReviewFindingTaskProjectionDemand scope={props.taskScope} /> : null}
                <ItemRowActions title={finding.title} overflowOnly overflowTriggerTestID={`review-finding-actions:${rowId}`}
                    actions={[{ id: `review-finding-task:${rowId}`, title: t('runPage.review.createTask'), icon: 'check-square',
                        onPress: () => { void onCreateTask(rowId); } }]} />
            </>
        ) : null;
        return (
            <ReviewFindingPageRow
                {...props}
                decisionControl={actions ? (
                    <View style={styles.pageControls}>{decisionControl}{actions}</View>
                ) : decisionControl}
                taskControl={null}
                ask={ask}
            />
        );
    }

    const threadToggle = props.followUp !== null ? (
        <Pressable
            testID={replyCount > 0 ? `review-finding-replies:${rowId}` : `review-finding-ask:${rowId}`}
            accessibilityRole="button"
            accessibilityState={{ expanded: props.expanded, disabled: askDisabled && replyCount === 0 }}
            accessibilityHint={askDisabled && props.followUp && !props.followUp.available ? props.followUp.reason : undefined}
            disabled={askDisabled && replyCount === 0}
            onPress={() => onToggleExpanded(rowId)}
            style={styles.ask}
        >
            <Icon name="chat" size={ICON_SIZE.xs} color={askDisabled && replyCount === 0 ? theme.colors.text.tertiary : theme.colors.text.secondary} />
            <StructuredFindText blockId={`${props.findBlockPrefix}:thread-toggle`} text={replyCount > 0 ? t('runPage.review.replies', { count: replyCount }) : t('runPage.review.askAboutThis')} style={[styles.askText, askDisabled && replyCount === 0 ? styles.askTextDisabled : null]} />
            {replyCount > 0 ? (
                <DisclosureCaret expanded={props.expanded} size={ICON_SIZE.xs} />
            ) : null}
        </Pressable>
    ) : null;

    return (
        <View testID={`review-finding:${rowId}`} style={[styles.finding, props.divided ? styles.divided : null]}>
            <View style={styles.severity}>
                <ReviewSeverityLabel severity={finding.severity} findBlockId={`${props.findBlockPrefix}:severity`} />
            </View>
            <View style={styles.body}>
                <View style={styles.headRow}>
                    <View style={styles.head}>
                        <StructuredFindText blockId={`${props.findBlockPrefix}:title`} text={finding.title} style={styles.title} />
                        {location || props.attribution ? (
                            <View style={styles.placeRow}>
                                {location ? <StructuredFindText blockId={`${props.findBlockPrefix}:location`} text={location} selectable numberOfLines={1} style={styles.location} /> : null}
                                {props.attribution ? (
                                    <View testID={`review-finding-attribution:${rowId}`} style={styles.attribution}>
                                        {props.attribution.backendIds.map((backendId) => (hasAgentIconMark(backendId, theme)
                                            ? <AgentIcon key={backendId} agentId={backendId} size={ICON_SIZE.xs} />
                                            : null))}
                                        <Text numberOfLines={1} style={styles.attributionText}>{props.attribution.label}</Text>
                                    </View>
                                ) : null}
                            </View>
                        ) : null}
                    </View>
                    {decisionControl ?? (props.decision !== null ? <Text style={styles.decisionAside} variant="meta">
                        {props.resolution ?? reviewFindingDecisionLabel(props.decision)}
                    </Text> : null)}
                </View>
                <ReviewFindingUpdatedNotice rowId={rowId} finding={finding} original={props.original} findBlockPrefix={props.findBlockPrefix} />
                {props.decision !== null && props.decisionNote ? <StructuredFindText blockId={`${props.findBlockPrefix}:decision-note`} text={props.decisionNote} style={styles.note} /> : null}
                {threadToggle}
                {taskControl}
                {props.expanded && props.followUp !== null ? (
                    props.followUp.available && props.askContext ? (
                        <ReviewFindingThread
                            rowId={rowId}
                            finding={finding}
                            entries={props.threadEntries}
                            pendingQuestion={props.pendingQuestion}
                            askContext={props.askContext}
                            onAsk={ask}
                            findBlockPrefix={props.findBlockPrefix}
                        />
                    ) : (
                        <ReviewFindingThreadHistory entries={props.threadEntries} findBlockPrefix={props.findBlockPrefix} />
                    )
                ) : null}
            </View>
        </View>
    );
});

/** "Updated after your question · High → Medium": a reviewer's answer changed the finding. */
function ReviewFindingUpdatedNotice(props: Readonly<{ rowId: string; finding: ReviewFinding; original: ReviewFinding | null; findBlockPrefix?: string }>) {
    const { theme } = useUnistyles();
    if (props.original === null) return null;
    const severityChanged = props.original.severity !== props.finding.severity;
    return (
        <View testID={`review-finding-updated:${props.rowId}`} style={styles.updated}>
            <Icon name="arrows-clockwise" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <StructuredFindText blockId={`${props.findBlockPrefix}:updated`} text={t('runPage.review.updatedAfterQuestion')} style={styles.updatedText} />
            {severityChanged ? (
                <StructuredFindText blockId={`${props.findBlockPrefix}:updated-severity`} text={`${reviewSeverityLabel(props.original.severity)} → ${reviewSeverityLabel(props.finding.severity)}`} style={styles.updatedDelta} />
            ) : null}
        </View>
    );
}

export function reviewFindingDecisionGlyph(decision: ReviewFindingDecision | 'undecided' | null) {
    switch (decision) {
        case 'accept': return 'check-circle' as const;
        case 'reject': return 'minus-circle' as const;
        case 'defer': return 'clock' as const;
        default: return 'circle' as const;
    }
}

/**
 * A finding on a result page (Reviews lab round 11, merged B). At rest: its decision state, title and
 * one meta line (severity, place, who found it), with the decision word at the end. Opened: the
 * decision control beside the title and the shared finding body under it. Below the shared row-stack
 * width (a phone, a split pane) the body runs the full width and the control moves under the title.
 */
function ReviewFindingPageRow(props: Readonly<React.ComponentProps<typeof ReviewFindingRow> & {
    decisionControl: React.ReactNode;
    taskControl: React.ReactNode;
    ask: (messageMarkdown: string) => Promise<boolean>;
}>) {
    const { theme } = useUnistyles();
    const workTheme = useWorkTheme();
    const { finding, rowId, onToggleExpanded } = props;
    const location = formatReviewFindingLocation(finding);

    return (
        <HappierReviewFinding
            rowId={rowId}
            finding={finding}
            severityLabel={reviewSeverityLabel(finding.severity)}
            location={location ? <Text selectable numberOfLines={1} style={styles.location}>{location}</Text> : null}
            attribution={props.attribution ? (
                <View testID={`review-finding-attribution:${rowId}`} style={styles.attribution}>
                    {props.attribution.backendIds.map((backendId) => (hasAgentIconMark(backendId, theme)
                        ? <AgentIcon key={backendId} agentId={backendId} size={ICON_SIZE.xs} /> : null))}
                    <Text numberOfLines={1} style={styles.attributionText}>{props.attribution.label}</Text>
                </View>
            ) : null}
            facts={props.facts}
            decision={props.decision === null ? null : { value: props.decision, label: props.resolution ?? reviewFindingDecisionLabel(props.decision) }}
            decisionEditable={props.decisionEditable}
            decisionControl={props.decisionControl}
            decisionGlyph={<Icon name={reviewFindingDecisionGlyph(props.decision)} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
            {...(props.selection ? { selection: { ...props.selection, testID: `review-findings:select:${rowId}`,
                glyph: <SelectionCheckGlyph state={props.selection.selected ? 'checked' : 'unchecked'} /> } } : {})}
            expanded={props.expanded}
            onToggleExpanded={onToggleExpanded}
            divided={props.divided}
            theme={workTheme}
            host={WORK_HOST}
        >
            <ReviewFindingPageBody {...props} />
            {props.taskControl}
        </HappierReviewFinding>
    );
}

/**
 * The opened finding's body (why, where, verification, history, conversation) for a page whose header already
 * names the finding: the opened page row, and a phone's pushed finding page (lab `detail-finding-390`).
 */
export function ReviewFindingPageBody(props: Readonly<React.ComponentProps<typeof ReviewFindingRow> & {
    ask: (messageMarkdown: string) => Promise<boolean>;
}>) {
    const { finding, rowId } = props;
    const followUp = props.followUp;
    const conversation = followUp !== null && followUp.available && props.askContext ? (
        <ReviewFindingThreadEntries
            rowId={rowId}
            entries={props.threadEntries}
            pendingQuestion={props.pendingQuestion}
            askContext={props.askContext}
            onAsk={props.ask}
        />
    ) : props.threadEntries.length > 0 || (followUp !== null && !followUp.available) ? (
        <>
            {props.threadEntries.length > 0 ? <ReviewFindingThreadHistory entries={props.threadEntries} /> : null}
            {followUp !== null && !followUp.available ? (
                <Text testID={`review-finding-ask-unavailable:${rowId}`} style={styles.note}>{followUp.reason}</Text>
            ) : null}
        </>
    ) : null;

    return (
        <ReviewFindingBody
            rowId={rowId}
            finding={finding}
            currentBodyMarkdown={props.currentBodyMarkdown}
            reviewContext={props.reviewContext}
            seenBefore={props.seenBefore}
            reviewers={props.reviewers}
            notice={(
                <>
                    <ReviewFindingUpdatedNotice rowId={rowId} finding={finding} original={props.original} />
                    {props.decision !== null && props.decisionNote ? <Text style={styles.note}>{props.decisionNote}</Text> : null}
                </>
            )}
            conversation={conversation}
        />
    );
}

/** Replies stay readable after a review stops taking questions. */
function ReviewFindingThreadHistory(props: Readonly<{ entries: readonly ReviewFindingThreadEntryView[]; findBlockPrefix?: string }>) {
    return (
        <View style={styles.history}>
            {props.entries.map((entry, index) => entry.kind === 'comment' ? (
                <ReviewFindingCommentReply key={entry.comment.id} entry={entry} findBlockPrefix={props.findBlockPrefix} />
            ) : (
                <View key={`${entry.threadId}:${index}`} style={styles.historyEntry}>
                    <StructuredFindText blockId={`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:request`} text={entry.requestMarkdown} style={styles.summary} />
                    <StructuredFindText blockId={`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:reviewer`} text={entry.reviewerLabel} style={styles.historyAuthor} />
                    <StructuredFindText blockId={`${props.findBlockPrefix}:thread:${entry.threadId}:${entry.generatedAtMs}:${index}:answer`} text={entry.answerMarkdown} style={styles.summary} />
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    finding: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s12,
        paddingVertical: 14,
    },
    divided: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    severity: {
        width: REVIEW_SEVERITY_COLUMN_WIDTH_PX,
        paddingTop: theme.space.s2,
    },
    body: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s6,
    },
    headRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: theme.space.s10,
    },
    head: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 200,
        minWidth: 0,
        gap: theme.space.s2,
    },
    title: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
    },
    placeRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s8,
        rowGap: theme.space.s2,
    },
    location: {
        ...Typography.variant('meta'),
        ...Typography.mono(),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    attribution: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    attributionText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    updated: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    updatedText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body', 'semiBold'),
    },
    updatedDelta: {
        color: theme.colors.text.tertiary,
        ...Typography.variant('body'),
    },
    summary: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    metaText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
    pageControls: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s8,
        maxWidth: '100%',
    },
    decisionOpened: {
        alignSelf: 'flex-start',
        flexShrink: 0,
        maxWidth: '100%',
    },
    decisionAside: {
        alignSelf: 'flex-start',
        flexShrink: 0,
        maxWidth: '100%',
    },
    ask: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s6,
        paddingVertical: theme.space.s4,
    },
    askText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body', 'semiBold'),
    },
    askTextDisabled: {
        color: theme.colors.text.tertiary,
    },
    note: {
        color: theme.colors.text.tertiary,
        ...Typography.variant('meta'),
    },
    history: {
        gap: theme.space.s10,
        paddingTop: theme.space.s6,
    },
    historyEntry: {
        gap: theme.space.s2,
    },
    historyAuthor: {
        color: theme.colors.text.primary,
        ...Typography.variant('body', 'semiBold'),
    },
}));
