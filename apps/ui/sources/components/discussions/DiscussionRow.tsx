import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import { readDiscussionMessagePreview, resolveDiscussionMessageSpeakerLabel } from './discussionTimelineProjection';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import type { DiscussionListAttention } from '@/activity/attention/buildDiscussionListAttention';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { resolveWorkStatusRowMark } from '@/components/work/status/workStatusRowMark';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { CollectionRequestPeek } from '@/components/ui/lists/collection/CollectionRequestPeek';
import type { CollectionRequestRef } from '@/components/ui/lists/collection/collectionRequestRef';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { classifyAccountActorLabelV1 } from '@happier-dev/protocol/account/accountDisplayProfileV1';
import { Item } from '@/components/ui/lists/Item';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HAPPIER_COLLECTION_ROW_METRICS, resolveHappierCollectionListRowPadding } from '@happier-dev/plugin-ui/presentation';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

/** The protocol supplies at most three recent authors. */
const AUTHOR_AVATAR_PX = 20;
/**
 * A column row's leading mark: the shared compact row's identity slot, as a Sessions row's, so a glyph stands on the
 * section label's edge and the title on the column's one text edge (owner, 2026-11-11).
 */
const COLUMN_MARK_PX = HAPPIER_COLLECTION_ROW_METRICS.identity.compact.slotSize;

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default(),
        ...ITEM_TITLE_TEXT_METRICS.compact,
        color: theme.colors.text.primary,
    },
    titleUnread: { ...Typography.default('semiBold') },
    subtitle: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
    },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, flexShrink: 0 },
    badge: { position: 'relative', top: 0, right: 0 },
    time: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.tight,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));

type RowLabels = Readonly<{
    you: string;
    viaAgent: string;
    messages: (count: number) => string;
    unread: (count: number) => string;
    mentions: (count: number) => string;
    onDoc: string;
    openComments: (count: number) => string;
    freshOpinions: (count: number) => string;
    freshOpinionsSynthesis: (count: number) => string;
    answerReviewSettled: string;
}>;

/**
 * What the Discussion is, as the server's content-free summary facts say it (lab T2-L): a settled or
 * answered round, or how many comments a Doc conversation holds. Null when no fact applies, so the row
 * keeps the conversation itself; a pending round (no answers yet), an unknown fact and a Doc with nothing
 * open are not summaries.
 */
export function resolveDiscussionRowSummary(
    discussion: Pick<DiscussionOpenedSummaryV1, 'anchor' | 'roundOutcomeV1' | 'openCommentCount'>,
    labels: Pick<RowLabels, 'onDoc' | 'openComments' | 'freshOpinions' | 'freshOpinionsSynthesis' | 'answerReviewSettled'>,
): string | null {
    const outcome = discussion.roundOutcomeV1;
    if (outcome?.pattern === 'fresh_opinions' && outcome.answerCount > 0) {
        return outcome.synthesized ? labels.freshOpinionsSynthesis(outcome.answerCount) : labels.freshOpinions(outcome.answerCount);
    }
    if (outcome?.pattern === 'answer_and_review' && outcome.settled) return labels.answerReviewSettled;
    const open = discussion.openCommentCount;
    if (discussion.anchor?.kind === 'doc' && typeof open === 'number' && open > 0) {
        return `${labels.onDoc} · ${labels.openComments(open)}`;
    }
    return null;
}

/**
 * The row's second line: who wrote last, then how long the conversation is. Unread and mention
 * counts are not repeated here — they are the badges at the row's end.
 */
export function buildDiscussionRowSubtitle(input: Readonly<{
    latestAuthor: string | null;
    latestIsViewer: boolean;
    producedByAgent: boolean;
    messageCount: number;
    labels: RowLabels;
}>): readonly string[] {
    const author = input.latestIsViewer ? input.labels.you : input.latestAuthor;
    return [
        author ?? '',
        input.producedByAgent ? input.labels.viaAgent : '',
        input.labels.messages(input.messageCount),
    ].filter((value) => value.length > 0);
}

/** One spoken name for the row: the title, the attention the badges carry, the subtitle, the time. */
export function buildDiscussionRowAccessibilityLabel(input: Readonly<{
    title: string;
    subtitle: readonly string[];
    unreadCount: number;
    unreadMentionCount: number;
    relativeTime: string;
    labels: Pick<RowLabels, 'unread' | 'mentions'>;
}>): string {
    const facts = [
        input.unreadMentionCount > 0 ? input.labels.mentions(input.unreadMentionCount) : '',
        input.unreadCount > 0 ? input.labels.unread(input.unreadCount) : '',
        ...input.subtitle,
        input.relativeTime,
    ].filter((value) => value.length > 0);
    return `${input.title}. ${facts.join(', ')}`;
}

function readLatestSpeakerName(discussion: DiscussionOpenedSummaryV1): string {
    return resolveDiscussionMessageSpeakerLabel(discussion.latestMessage, {
        session: () => null,
        workflowRun: () => null,
    });
}

export function readDiscussionRowAccountAvatar(
    actor: DiscussionOpenedSummaryV1['latestMessage']['accountActor'],
    accountId: string,
    viewerAccountId: string,
) {
    if (actor?.accountId !== accountId) return { id: accountId, imageUrl: null };
    const isFormer = classifyAccountActorLabelV1(actor, actor.accountId === viewerAccountId).kind === 'former';
    return {
        id: isFormer ? 'former-member' : accountId,
        imageUrl: isFormer ? null : actor.profile?.avatarUrl ?? null,
    };
}

export function readDiscussionRowAccountAvatarUrl(discussion: DiscussionOpenedSummaryV1, accountId: string, viewerAccountId: string): string | null {
    return readDiscussionRowAccountAvatar(discussion.latestMessage.accountActor, accountId, viewerAccountId).imageUrl;
}

/** The last message as one quiet line, "Mei: let's ask the bot…" (lab T2-A); null when it can't be opened. */
function readLatestPreview(discussion: DiscussionOpenedSummaryV1, viewerAccountId: string): string | null {
    const content = discussion.latestMessage.content;
    if (!content) return null;
    const accountName = (accountId: string) => {
        const actor = discussion.participantAccounts?.find(candidate => candidate.accountId === accountId)
            ?? (discussion.latestMessage.accountActor?.accountId === accountId ? discussion.latestMessage.accountActor : null);
        return actor ? resolveAccountActorName(actor, actor.accountId === viewerAccountId) : null;
    };
    const text = readDiscussionMessagePreview(content, { account: accountName });
    if (text === null) return null;
    const author = discussion.latestMessage.producerV1 === null
        && discussion.latestMessage.authorAccountId === viewerAccountId
        ? rowLabels.you
        : readLatestSpeakerName(discussion);
    return author ? `${author}: ${text}` : text;
}

/**
 * A Discussion with nobody else in it (a second opinion, a talk with agents about a Doc) is marked by what it
 * is about, not by the viewer's own face (lab T2-L). Null keeps the faces, including when who is in it is
 * unknown.
 */
export function resolveDiscussionRowGlyph(
    discussion: Pick<DiscussionOpenedSummaryV1, 'anchor' | 'participantAccounts'>,
    viewerAccountId: string,
): IconName | null {
    const accounts = discussion.participantAccounts;
    if (!accounts || accounts.some(actor => actor.accountId !== viewerAccountId)) return null;
    if (discussion.anchor?.kind === 'session' && discussion.anchor.messageId) return 'scales';
    if (discussion.anchor?.kind === 'doc') return 'file-text';
    return 'robot';
}

const rowLabels: RowLabels = {
    get you() { return t('session.collaboration.pane.you'); },
    get viaAgent() { return t('session.collaboration.discussion.viaAgent'); },
    messages: (count) => t('session.collaboration.discussion.messageCount', { count }),
    unread: (count) => t('session.collaboration.discussion.unreadCount', { count }),
    mentions: (count) => t('session.collaboration.discussion.unreadMentionCount', { count }),
    get onDoc() { return t('session.collaboration.discussion.rowOnDoc'); },
    openComments: (count) => t('session.collaboration.discussion.rowOpenComments', { count }),
    freshOpinions: (count) => t('session.collaboration.discussion.rowFreshOpinions', { count }),
    freshOpinionsSynthesis: (count) => t('session.collaboration.discussion.rowFreshOpinionsSynthesis', { count }),
    get answerReviewSettled() { return t('session.collaboration.discussion.rowAnswerReviewSettled'); },
};

/**
 * One conversation in the Collaboration pane (lab C1): up to three recent authors, the title (bold
 * while unread), who wrote last and how many messages, then the mention indicator, unread count and the
 * time at the row's end.
 */
export const DiscussionRow = React.memo(function DiscussionRow(props: Readonly<{
    discussion: DiscussionOpenedSummaryV1;
    /** The viewing Account, so its own last message reads "You". */
    viewerAccountId: string;
    onOpenDiscussion: (discussionId: string, title?: string | null) => void;
    selected?: boolean;
    /** `column`: a row of the Discussions column, on the list anatomy's gutter and selected chip. */
    geometry?: 'pane' | 'column';
    /** What needs the viewer here, from the list's attention projection. */
    attentionReason: DiscussionListAttention['attentionReason'];
    attentionType: DiscussionListAttention['attentionType'];
    agentName?: string | null;
    /** Qualified by the list's existing scoped approval join; the row never loads an inventory. */
    serverId?: string;
    approvalArtifactId?: string;
    statusWords?: boolean;
    presented?: boolean;
}>): React.ReactElement {
    const { discussion } = props;
    const workStatus = resolveWorkStatusTone({ kind: 'discussion', facts: props });
    const { theme } = useUnistyles();
    const requestRef = React.useMemo<CollectionRequestRef | null>(() => props.serverId && props.approvalArtifactId
        ? { kind: 'approval', serverId: props.serverId, artifactId: props.approvalArtifactId } : null,
    [props.approvalArtifactId, props.serverId]);
    const title = discussion.title ?? t('session.collaboration.discussion.encryptedTitle');
    const unread = discussion.unreadCount > 0;
    const mentioned = unread && discussion.unreadMentionCount > 0;
    const relativeTime = formatShortRelativeTime(discussion.latestMessage.createdAt);
    const subtitle = buildDiscussionRowSubtitle({
        latestAuthor: readLatestSpeakerName(discussion),
        latestIsViewer: discussion.latestMessage.producerV1 === null
            && discussion.latestMessage.authorAccountId === props.viewerAccountId,
        producedByAgent: discussion.latestMessage.producerV1?.kind === 'agent',
        messageCount: discussion.messageSeq,
        labels: rowLabels,
    });
    const column = props.geometry === 'column';
    // The column shows up to two faces in one leading slot, so a row with nobody else in it reserves nothing extra
    // and every title keeps one edge (owner 2026-11-05). In a pane the row leads with one mark, its latest author, in
    // the pane's icon column, so the title shares the text edge of every other row there; the second line says who wrote.
    const authorSlots = column ? 2 : 1;
    // The column's faces are who is in it (owner and invited people, others first), not who wrote last.
    const participants = column && discussion.participantAccounts?.length
        ? [...discussion.participantAccounts.filter(actor => actor.accountId !== props.viewerAccountId),
            ...discussion.participantAccounts.filter(actor => actor.accountId === props.viewerAccountId)]
        : null;
    const authors = participants
        ? participants.slice(0, authorSlots).map(actor => actor.accountId)
        : discussion.recentAuthorAccountIds.slice(0, authorSlots);
    const glyph = column ? resolveDiscussionRowGlyph(discussion, props.viewerAccountId) : null;
    const faceAvatar = (accountId: string) => readDiscussionRowAccountAvatar(
        participants?.find(candidate => candidate.accountId === accountId) ?? discussion.latestMessage.accountActor,
        accountId,
        props.viewerAccountId,
    );
    const selected = props.selected ?? false;
    // In the column the second line is the conversation itself (its latest message); what needs the viewer
    // is the row's calm status mark at its end (ruling 2026-11-01: approval and draft the amber dot, a mention the
    // ink dot); unread news is the bold title alone.
    const preview = column ? readLatestPreview(discussion, props.viewerAccountId) : null;
    const statusGlyph = (column || requestRef !== null) && resolveWorkStatusRowMark(workStatus) !== 'none'
        && workStatus.state !== 'unread' ? workStatus : null;
    // What needs the viewer is the column row's second line, in the attention ink (lab T2-L), in place of the
    // conversation; the glyph stays at the end as the request's peek, without repeating the word.
    const attentionLine = column && statusGlyph?.tone === 'attention' && statusGlyph.word ? statusGlyph.word : null;
    // Then what the Discussion is, from the list's summary facts (round outcome, open comments); a Doc
    // conversation without one says so before its latest message (lab T2-L "On a doc").
    const summaryLine = column ? resolveDiscussionRowSummary(discussion, rowLabels) : null;
    const conversation = preview ?? subtitle.join(' · ');
    const secondLine = attentionLine ?? summaryLine ?? (column && discussion.anchor?.kind === 'doc'
        ? [rowLabels.onDoc, conversation].filter(Boolean).join(' · ')
        : conversation);
    const statusContent = statusGlyph ? <View style={styles.trailing}>
        {props.statusWords && statusGlyph.word && !attentionLine ? <Text testID={`session-discussion-row-status-word-${discussion.id}`}
            variant="meta" numberOfLines={1} style={workStatusWordStyle(statusGlyph.tone)}>{statusGlyph.word}</Text> : null}
        <WorkStatusRowMark status={statusGlyph} testIDSuffix={`discussion-${discussion.id}`} animationEnabled={props.presented !== false} />
    </View> : null;
    const statusControl = statusContent && requestRef ? <CollectionRequestPeek request={requestRef}
        description={title} presented={props.presented} testID={`discussion-request-peek:${discussion.id}`}>
        {statusContent}
    </CollectionRequestPeek> : statusContent;
    return (
        <Item
            rowRole="item"
            testID={`session-discussion-row-${discussion.id}`}
            accessibilityRole="button"
            accessibilityLabel={buildDiscussionRowAccessibilityLabel({
                title,
                // The glyph's state is spoken first, as its word.
                subtitle: [...(statusGlyph?.word ? [statusGlyph.word] : []), ...(summaryLine ? [summaryLine] : []), ...subtitle],
                unreadCount: discussion.unreadCount,
                unreadMentionCount: mentioned ? discussion.unreadMentionCount : 0,
                relativeTime,
                labels: rowLabels,
            })}
            selected={selected}
            rightElementOutsidePressable={requestRef !== null}
            onPress={() => props.onOpenDiscussion(discussion.id, discussion.title)}
            {...(column ? {
                pressableStyle: selected ? [collectionListStyles.row, collectionListStyles.rowSelectedOnPlane] : collectionListStyles.row,
                style: resolveHappierCollectionListRowPadding(0),
                iconBoxSize: COLUMN_MARK_PX,
            } : {})}
            density="compact"
            showChevron={false}
            showDivider={false}
            {...(column ? { leftElement: <AvatarStack
                testID={`session-discussion-row-recent-authors-${discussion.id}`}
                size={COLUMN_MARK_PX}
                slot
                entries={glyph ? [{ key: 'glyph', avatar: false, testID: `session-discussion-row-glyph-${discussion.id}`,
                    content: <Icon name={glyph} size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> }]
                    : authors.map((accountId) => {
                    const avatar = faceAvatar(accountId);
                    return {
                        key: accountId,
                        testID: `session-discussion-row-recent-author-${discussion.id}-${accountId}`,
                        content: <Avatar id={avatar.id} imageUrl={avatar.imageUrl} size={COLUMN_MARK_PX} />,
                    };
                })}
            /> } : {
                // A pane row's one face takes the pane's icon slot itself, so its title starts on the same
                // text edge as Followers and Following beneath it.
                icon: authors[0] ? <View testID={`session-discussion-row-recent-authors-${discussion.id}`}>
                    <View testID={`session-discussion-row-recent-author-${discussion.id}-${authors[0]}`}>
                        <Avatar id={faceAvatar(authors[0]).id} imageUrl={faceAvatar(authors[0]).imageUrl} size={AUTHOR_AVATAR_PX} />
                    </View>
                </View> : undefined,
            })}
            title={<Text
                    testID={`session-discussion-row-title-${discussion.id}`}
                    style={[styles.title, unread ? styles.titleUnread : null, column && selected ? collectionListStyles.rowTitleSelectedOnPlane : null]}
                    numberOfLines={1}
                >
                    {title}
                </Text>}
            subtitle={<Text testID={`session-discussion-row-subtitle-${discussion.id}`} style={[styles.subtitle, attentionLine ? workStatusWordStyle('attention') : null]} numberOfLines={1}>{secondLine}</Text>}
            rightElement={<View style={styles.trailing} accessible={false} importantForAccessibility={requestRef ? 'auto' : 'no-hide-descendants'}>
                {mentioned && !column ? (
                    <TabBadge testID={`session-discussion-row-mention-${discussion.id}`} variant="dot" tone={workStatus.tone === 'neutral' ? 'neutral' : 'attention'} style={styles.badge} />
                ) : null}
                {unread ? (
                    <TabBadge testID={`session-discussion-row-unread-${discussion.id}`} variant="count" value={discussion.unreadCount} tone="neutral" style={styles.badge} />
                ) : null}
                {/* One status slot: the state's glyph, or how long ago it last spoke. */}
                {statusControl ? statusControl
                    : relativeTime ? <Text style={styles.time}>{relativeTime}</Text> : null}
            </View>}
        />
    );
});

const SKELETON_TITLE_WIDTHS = ['62%', '78%', '54%'] as const;

/**
 * A conversation row's reserved shape while the first page is read: the author mark, the title and
 * the second line, at the row's own geometry so the list does not move when the rows arrive.
 */
export function DiscussionRowSkeleton(props: Readonly<{ index: number; column?: boolean; testID?: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const color = theme.colors.surface.skeleton;
    return (
        <View testID={props.testID} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Item
                rowRole="item"
                mode="info" density="compact" showChevron={false} showDivider={false}
                {...(props.column ? { pressableStyle: collectionListStyles.row, style: resolveHappierCollectionListRowPadding(0), iconBoxSize: COLUMN_MARK_PX, leftElement: <AvatarStack size={COLUMN_MARK_PX} slot entries={[{
                    key: 'author', avatar: false,
                    content: <HappierSkeletonBlock color={color} width={COLUMN_MARK_PX} height={COLUMN_MARK_PX} radius={COLUMN_MARK_PX / 2} reducedMotion={reducedMotion} />,
                }]} /> } : {
                    // The row's face slot, where its one author arrives.
                    icon: <HappierSkeletonBlock color={color} width={AUTHOR_AVATAR_PX} height={AUTHOR_AVATAR_PX} radius={AUTHOR_AVATAR_PX / 2} reducedMotion={reducedMotion} />,
                })}
                title={<HappierSkeletonBlock color={color} width={SKELETON_TITLE_WIDTHS[props.index % SKELETON_TITLE_WIDTHS.length]} height={10} reducedMotion={reducedMotion} />}
                subtitle={<HappierSkeletonBlock color={color} width="36%" height={8} reducedMotion={reducedMotion} />}
            />
        </View>
    );
}
