import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { resolveReviewCommentBodyPromptDefault, resolveReviewCommentBodyText } from '@/components/reviews/content';
import { ReviewCommentCard } from '@/components/reviews/ReviewCommentCard';
import { ReviewFindingAnchor, ReviewFindingAnchorContext } from '@/components/reviews/ReviewFindingAnchor';
import { buildReviewCommentLabels } from '@/components/reviews/sessionSurfaceLabels';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { Avatar } from '@/components/ui/avatar/Avatar';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { getAvatarUrl } from '@/sync/domains/profiles/profile';
import { useProfile } from '@/sync/domains/state/storage';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { t } from '@/text';
import { resolveCodeLineAnchor } from './resolveCodeLineAnchor';
import { ReviewCommentDraftFrame, reviewCommentDraftText, reviewCommentSlot } from './ReviewCommentDraftFrame';

type Labels = ReturnType<typeof buildReviewCommentLabels>;

/**
 * The saved Review notes at one line (or one file): its findings first, as the line's glance, then its
 * comments in the order they arrived, on the comment slot's one edge.
 */
export function SavedReviewCommentNotes(props: Readonly<{
    comments: readonly ReviewCommentV1[];
    serverId?: string;
}>) {
    const openFinding = React.useContext(ReviewFindingAnchorContext);
    if (props.comments.length === 0) return null;
    const labels = buildReviewCommentLabels();
    const ordered = [...props.comments.filter(comment => comment.finding), ...props.comments.filter(comment => !comment.finding)];
    return (
        <View style={reviewCommentSlot.slot}>
            {ordered.map(comment => openFinding && comment.finding
                ? <ReviewFindingAnchor key={comment.id} comment={comment} onOpen={openFinding} />
                : comment.finding
                    ? <ReviewCommentCard key={comment.id} comment={comment} serverId={props.serverId} labels={labels} />
                    : <SavedReviewCommentNote key={comment.id} comment={comment} labels={labels} />)}
        </View>
    );
}

/** Where on the file the note sits, as the change header says it ("line 2", "lines 4–6"); a file note says nothing. */
function lineMeta(comment: ReviewCommentV1): string | undefined {
    const anchor = comment.anchor;
    if (anchor.kind === 'line') return t('hunkReview.line', { line: anchor.line });
    if (anchor.kind === 'range') return anchor.startLine === anchor.endLine
        ? t('hunkReview.line', { line: anchor.startLine })
        : t('hunkReview.lines', { start: anchor.startLine, end: anchor.endLine });
    return undefined;
}

/**
 * A saved comment keeps the card it was written in: who wrote it and where, over its text. Its state shows
 * only when the reader has to act on it (stale, outdated) or it is settled; your own pending comment reads
 * as yours, not as a warning.
 */
function SavedReviewCommentNote(props: Readonly<{ comment: ReviewCommentV1; labels: Labels }>) {
    const { theme } = useUnistyles();
    const profile = useProfile();
    const { comment, labels } = props;
    const author = comment.author;
    const settled = comment.state === 'resolved' || comment.state === 'dismissed' ? labels.states[comment.state] : undefined;
    const meta = [lineMeta(comment), settled].filter(Boolean).join(' · ') || undefined;
    let mark: React.ReactNode = null;
    let name: string;
    if (author.kind === 'user' && author.userId === profile.id) {
        mark = <Avatar id={profile.id} imageUrl={getAvatarUrl(profile)} thumbhash={profile.avatar?.thumbhash} size={18} />;
        name = t('detailsSurface.review.draftAuthor');
    } else if (author.kind === 'user') {
        const person = presentSharePrincipal({ ref: { kind: 'account', accountId: author.userId }, viewerAccountId: profile.id });
        mark = person.avatar ? <Avatar id={person.avatar.id} imageUrl={person.avatar.imageUrl ?? null} size={18} /> : null;
        name = person.displayName;
    } else {
        const engine = comment.engineId ?? (author.kind === 'agent' ? author.agentId : author.kind === 'plugin' ? author.pluginId : null);
        mark = engine && hasAgentIconMark(engine, theme) ? <AgentIcon agentId={engine} size={ICON_SIZE.sm} /> : null;
        name = engine ? resolveAgentCatalogTitle(engine) : labels.engine;
    }
    const readable = comment.flags.redacted ? undefined : resolveReviewCommentBodyPromptDefault(comment.body);
    return (
        <ReviewCommentDraftFrame
            testID={`review-comment-${comment.id}`}
            author={{ mark, name, meta }}
            headerTrailing={comment.flags.stale || comment.flags.outdated ? (
                <>
                    {comment.flags.stale ? <StatusPill variant="warning" label={labels.stale} hideDot /> : null}
                    {comment.flags.outdated ? <StatusPill variant="neutral" label={labels.outdated} hideDot /> : null}
                </>
            ) : undefined}
        >
            {readable !== undefined
                ? <MarkdownView markdown={readable} textStyle={reviewCommentDraftText.body}
                    renderCacheKey={`review-comment:${comment.id}:${comment.bodyVersion}:line`} />
                : <Text selectable style={reviewCommentDraftText.body}>
                    {comment.flags.redacted ? labels.redacted : resolveReviewCommentBodyText(comment.body, labels)}
                </Text>}
        </ReviewCommentDraftFrame>
    );
}

export function getSavedReviewFileNotes(params: Readonly<{
    comments?: readonly ReviewCommentV1[];
    filePath: string;
    previousFilePath?: string;
}>) {
    return params.comments?.filter(comment => !comment.parentCommentId && comment.anchor.kind === 'file'
        && (comment.anchor.filePath === params.filePath || comment.anchor.filePath === params.previousFilePath)) ?? [];
}

export function useSavedReviewCommentLines(params: Readonly<{
    comments?: readonly ReviewCommentV1[];
    filePath: string;
    previousFilePath?: string;
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    serverId?: string;
}>) {
    const commentsByLineId = React.useMemo(() => {
        const result = new Map<string, ReviewCommentV1[]>();
        for (const comment of params.comments ?? []) {
            if (comment.parentCommentId || (comment.anchor.kind !== 'line' && comment.anchor.kind !== 'range')) continue;
            const filePath = comment.anchor.side === 'before' && comment.anchor.filePath === params.previousFilePath
                ? comment.anchor.filePath : params.filePath;
            const resolution = resolveCodeLineAnchor({ filePath, source: params.source, lines: params.lines, anchor: comment.anchor });
            const lineId = resolution.lines.at(-1)?.id;
            if (!lineId) continue;
            const comments = result.get(lineId);
            if (comments) comments.push(comment);
            else result.set(lineId, [comment]);
        }
        return result;
    }, [params.comments, params.filePath, params.previousFilePath, params.lines, params.source]);
    const renderAfterLine = React.useCallback((line: CodeLine) => {
        const comments = commentsByLineId.get(line.id);
        return comments ? <SavedReviewCommentNotes comments={comments} serverId={params.serverId} /> : null;
    }, [commentsByLineId, params.serverId]);
    return commentsByLineId.size > 0 ? renderAfterLine : undefined;
}
