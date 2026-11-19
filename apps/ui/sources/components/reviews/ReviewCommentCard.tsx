import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ReviewCommentStateV1, ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { reviewCommentTransitionTargetsV1 } from '@happier-dev/protocol/reviews/comments/mutation';
import type { ReviewTriageStatus } from '@happier-dev/protocol/reviews/reviewTriageStatus';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ReviewSeverityLabel } from '@/components/sessions/reviews/findings/ReviewSeverity';
import { ReviewFindingBody } from './finding/ReviewFindingBody';
import { ReviewFindingDecisionControl } from '@/components/sessions/reviews/findings/ReviewFindingRow';
import { readReviewFindingDecision } from '@/components/sessions/reviews/findings/reviewFindingComment';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { ReviewCommentLabels } from './labels';
import { ReviewCommentSnapshotView } from './ReviewCommentSnapshotView';
import { resolveReviewCommentBodyPromptDefault, resolveReviewCommentBodyText, splitReviewCommentBody } from './content';

export type ReviewCommentCardProps = Readonly<{
    comment: ReviewCommentV1;
    serverId?: string;
    labels: ReviewCommentLabels;
    actions?: ReviewCommentCardActions;
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
    testID?: string;
}>;

export type ReviewCommentCardTransitionInput = Readonly<{
    comment: ReviewCommentV1;
    toState: ReviewCommentStateV1;
}>;

export type ReviewCommentCardActions = Readonly<{
    /** File locations open through the workspace Action; the page composition owns the link. */
    onOpenFile?: (comment: ReviewCommentV1) => void;
    canOpenFile?: (comment: ReviewCommentV1) => boolean;
    onEdit?: (comment: ReviewCommentV1) => void;
    onTransition?: (input: ReviewCommentCardTransitionInput) => void;
    onRedact?: (comment: ReviewCommentV1) => void;
    onDelegate?: (comment: ReviewCommentV1) => void;
    onDecide?: (comment: ReviewCommentV1, decision: ReviewTriageStatus) => void;
    pendingDecision?: (comment: ReviewCommentV1) => ReviewTriageStatus | undefined;
    /** Replies to the thread this comment opens; the host passes it to a thread's root only, so a thread has one Reply. */
    onReply?: (comment: ReviewCommentV1) => void;
    /** A line the caller owns for this comment (the failure of an action taken on it), under its actions. */
    renderNotice?: (comment: ReviewCommentV1) => React.ReactNode;
}>;

/** Where the comment points, as the mono meta reads it: the path, with its line or range when it has one. */
function anchorLocation(comment: ReviewCommentV1): string | null {
    const anchor = comment.anchor;
    if (anchor.kind === 'line') return `${anchor.filePath}:${anchor.line}`;
    if (anchor.kind === 'range') {
        return anchor.startLine === anchor.endLine
            ? `${anchor.filePath}:${anchor.startLine}`
            : `${anchor.filePath}:${anchor.startLine}–${anchor.endLine}`;
    }
    if ('filePath' in anchor) return anchor.filePath;
    if ('folderPath' in anchor) return anchor.folderPath;
    return null;
}

/** The engine or Agent that wrote the comment; a person's own comment carries no identity line. */
function engineOf(comment: ReviewCommentV1): string | null {
    if (comment.engineId) return comment.engineId;
    if (comment.author.kind === 'agent') return comment.author.agentId;
    if (comment.author.kind === 'plugin') return comment.author.pluginId;
    return null;
}

function isTerminalComment(comment: ReviewCommentV1): boolean {
    return comment.flags.redacted === true || Boolean(comment.tombstone);
}

/** A closed or removed comment takes no reply; the thread says so instead of hiding the entry. */
function isReplyUnavailable(comment: ReviewCommentV1): boolean {
    return isTerminalComment(comment) || comment.state === 'resolved' || comment.state === 'dismissed';
}

function transitionLabel(labels: ReviewCommentLabels, state: ReviewCommentStateV1, from: ReviewCommentStateV1): string {
    if (state === 'resolved') return labels.resolve;
    if (state === 'dismissed') return labels.dismiss;
    if (state === 'open' && (from === 'resolved' || from === 'dismissed')) return labels.reopen;
    return labels.states[state];
}

function isForwardTransition(state: ReviewCommentStateV1, from: ReviewCommentStateV1): boolean {
    return state === 'resolved' || (state === 'open' && (from === 'proposed' || from === 'resolved' || from === 'dismissed'));
}

function transitionTestId(state: ReviewCommentStateV1, from: ReviewCommentStateV1): string {
    if (state === 'resolved') return 'resolve';
    if (state === 'dismissed') return 'dismiss';
    if (state === 'open' && (from === 'resolved' || from === 'dismissed')) return 'reopen';
    return state;
}

const STATE_VARIANT: Readonly<Record<ReviewCommentStateV1, StatusPillVariant>> = {
    proposed: 'attention',
    open: 'info',
    delegated: 'neutral',
    pending_review: 'neutral',
    resolved: 'success',
    dismissed: 'neutral',
};

export function ReviewCommentCard(props: ReviewCommentCardProps) {
    const { theme } = useUnistyles();
    const [localExpanded, setLocalExpanded] = React.useState(false);
    const expanded = props.expanded ?? localExpanded;
    const setExpanded = props.onExpandedChange ?? setLocalExpanded;
    const [moreOpen, setMoreOpen] = React.useState(false);
    const location = anchorLocation(props.comment);
    const engine = engineOf(props.comment);
    const disabled = isTerminalComment(props.comment);
    const finding = !disabled && props.comment.reviewId ? props.comment.finding : undefined;
    const testID = props.testID ?? `review-comment-${props.comment.id}`;
    // Only readable plain text is Markdown; a redacted or unreadable body is its one quiet sentence.
    const readable = props.comment.flags.redacted ? undefined : resolveReviewCommentBodyPromptDefault(props.comment.body);
    const parts = readable !== undefined ? splitReviewCommentBody(readable) : null;
    const fallback = props.comment.flags.redacted ? props.labels.redacted : resolveReviewCommentBodyText(props.comment.body, props.labels);
    const notice = props.actions?.renderNotice?.(props.comment) ?? null;

    // Folding is reading: it follows the folded text itself, not the action row.
    const fold = parts?.rest ? (
        <View style={styles.fold}>
            <TextLinkButton
                label={expanded ? props.labels.showLess : props.labels.showMore}
                size="meta"
                expanded={expanded}
                onPress={() => setExpanded(!expanded)}
                testID={`${testID}-fold`}
            />
        </View>
    ) : null;

    const action = (label: string, onPress: () => void, id: string, tone: 'quiet' | 'strong' = 'quiet') => (
        <TextLinkButton key={id} label={label} tone={tone} disabled={disabled} onPress={onPress} testID={`${testID}-${id}`} />
    );

    // Delegation and verification use their existing workflow controls. The row keeps the one move forward
    // (Open a proposal, Resolve, Reopen) and Dismiss; every other action sits behind More.
    const targets = props.actions?.onTransition && !finding
        ? reviewCommentTransitionTargetsV1(props.comment.state).filter((state) => state !== 'delegated' && state !== 'pending_review')
        : [];
    const onRow = (state: ReviewCommentStateV1) => state === 'dismissed' || isForwardTransition(state, props.comment.state);
    const moreItems: ReadonlyArray<Readonly<{ id: string; title: string; destructive?: boolean; run: () => void }>> = [
        ...(props.actions?.onEdit ? [{ id: 'edit', title: props.labels.edit, run: () => props.actions?.onEdit?.(props.comment) }] : []),
        ...(props.actions?.onDelegate && ['proposed', 'open', 'pending_review', 'delegated'].includes(props.comment.state)
            ? [{ id: 'delegate', title: props.labels.delegate ?? props.labels.states.delegated, run: () => props.actions?.onDelegate?.(props.comment) }] : []),
        ...targets.filter((state) => !onRow(state)).map((toState) => ({
            id: transitionTestId(toState, props.comment.state),
            title: transitionLabel(props.labels, toState, props.comment.state),
            run: () => props.actions?.onTransition?.({ comment: props.comment, toState }),
        })),
        ...(props.actions?.onRedact ? [{ id: 'redact', title: props.labels.redact, destructive: true, run: () => props.actions?.onRedact?.(props.comment) }] : []),
    ];
    const replyUnavailable = isReplyUnavailable(props.comment);
    const hasActions = targets.some(onRow) || Boolean(props.actions?.onReply) || moreItems.length > 0;

    return (
        <View testID={props.testID} style={styles.card}>
            {/* The finding card's head: severity, who found it and where, then this comment's own state. */}
            <View style={styles.head}>
                {props.comment.findingSeverity ? <ReviewSeverityLabel severity={props.comment.findingSeverity} /> : null}
                {engine ? (
                    <View testID={`${testID}-engine`} style={styles.engine}>
                        {hasAgentIconMark(engine, theme) ? <AgentIcon agentId={engine} size={ICON_SIZE.xs} /> : null}
                        <Text variant="meta" numberOfLines={1} style={styles.meta}>{resolveAgentCatalogTitle(engine)}</Text>
                    </View>
                ) : null}
                {location ? <Text numberOfLines={1} style={styles.path}>{location}</Text> : null}
                <View style={styles.grow} />
                {props.comment.flags.stale ? <StatusPill variant="warning" label={props.labels.stale} hideDot /> : null}
                {props.comment.flags.outdated ? <StatusPill variant="neutral" label={props.labels.outdated} hideDot /> : null}
                <StatusPill variant={STATE_VARIANT[props.comment.state]} label={props.labels.states[props.comment.state]} />
            </View>
            {finding ? <Text selectable style={styles.title}>{finding.title}</Text>
                : parts?.title ? <Text selectable style={styles.title}>{parts.title}</Text> : null}
            {finding ? <ReviewFindingBody rowId={props.comment.id} finding={finding} currentBodyMarkdown={readable}
                reviewContext={props.serverId && props.comment.reviewId
                    ? { reviewId: props.comment.reviewId, commentId: props.comment.id, serverId: props.serverId } : undefined}
                reviewers={engine ? [{ label: resolveAgentCatalogTitle(engine), backendId: engine }] : []} conversation={null} /> : parts ? (
                <>
                    {parts.lead ? <MarkdownView markdown={parts.lead} textStyle={styles.body} renderCacheKey={`review-comment:${props.comment.id}:${props.comment.bodyVersion}:lead`} /> : null}
                    {parts.rest && expanded ? <MarkdownView markdown={parts.rest} textStyle={styles.body} renderCacheKey={`review-comment:${props.comment.id}:${props.comment.bodyVersion}:rest`} /> : null}
                    {fold}
                </>
            ) : <Text selectable style={styles.body}>{fallback}</Text>}
            {finding ? null : <ReviewCommentSnapshotView comment={props.comment} labels={props.labels} />}
            {finding && props.actions?.onDecide ? <ReviewFindingDecisionControl
                testIDPrefix={`review-finding-triage:${props.comment.id}`}
                decision={readReviewFindingDecision(props.comment.reviewTriageStatus, props.comment.state, props.actions.pendingDecision?.(props.comment))}
                disabled={disabled} onDecide={(decision) => props.actions?.onDecide?.(props.comment, decision)} /> : null}
            {hasActions ? (
                <View style={styles.actions}>
                    {targets.filter(onRow).map((toState) => action(
                        transitionLabel(props.labels, toState, props.comment.state),
                        () => props.actions?.onTransition?.({ comment: props.comment, toState }),
                        transitionTestId(toState, props.comment.state),
                        isForwardTransition(toState, props.comment.state) ? 'strong' : 'quiet',
                    ))}
                    {props.actions?.onReply ? (
                        <TextLinkButton
                            label={replyUnavailable ? props.labels.replyUnavailable : props.labels.reply}
                            disabled={replyUnavailable}
                            onPress={() => props.actions?.onReply?.(props.comment)}
                            testID={`${testID}-reply`}
                        />
                    ) : null}
                    {moreItems.length > 0 ? (
                        <>
                            <View style={styles.grow} />
                            <DropdownMenu
                                open={moreOpen}
                                onOpenChange={setMoreOpen}
                                items={moreItems.map((item) => ({ id: item.id, title: item.title, destructive: item.destructive, testID: `${testID}-${item.id}` }))}
                                onSelect={(id) => moreItems.find((item) => item.id === id)?.run()}
                                placement="auto"
                                matchTriggerWidth={false}
                                trigger={({ open, toggle }) => (
                                    <IconButton
                                        testID={`${testID}-more`}
                                        iconName="dots-three"
                                        size={24}
                                        iconSize={ICON_SIZE.sm}
                                        variant="plain"
                                        disabled={disabled}
                                        accessibilityLabel={t('common.moreActions')}
                                        onPress={toggle}
                                        expanded={open}
                                        hasPopup="menu"
                                    />
                                )}
                            />
                        </>
                    ) : null}
                </View>
            ) : null}
            {notice}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    card: { gap: theme.space.s6, paddingVertical: theme.space.s12 },
    head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s8 },
    engine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, flexShrink: 0 },
    meta: { color: theme.colors.text.secondary },
    path: { ...Typography.mono(), fontSize: 12, color: theme.colors.text.secondary, flexShrink: 1, minWidth: 0 },
    // The finding card's reading: title in label weight, the summary in the secondary body colour.
    title: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary },
    body: { ...Typography.variant('body'), color: theme.colors.text.secondary },
    grow: { flexGrow: 1 },
    fold: { alignSelf: 'flex-start' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.s16, rowGap: theme.space.s4 },
}));
