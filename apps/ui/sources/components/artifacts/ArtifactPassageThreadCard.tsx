import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierThreadMessage } from '@happier-dev/plugin-ui/components';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';

import { DiscussionMessageContent } from '@/components/discussions/DiscussionMessageContent';
import { resolveDiscussionMessageAuthorLabel, resolveDiscussionMessageSpeakerLabel } from '@/components/discussions/discussionTimelineProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { useDiscussionRequesterApprovals, useSessionDisplayNameProjections } from '@/sync/domains/state/storage';
import { useDiscussionSessionAgentIdProjection, useDiscussionSessionLabelProjection } from '@/components/discussions/discussionSessionLabel';
import { DiscussionSpeakerFace } from '@/components/discussions/DiscussionSpeakerFace';
import { DiscussionWaitingApprovalCard } from '@/components/discussions/DiscussionWaitingApprovalCard';
import { ApprovalRequesterThreadCard } from '@/components/approvals/ApprovalRequesterThreadCard';
import { ArtifactPassageThreadReply } from './ArtifactPassageThreadReply';

import type { ArtifactActionsClient } from './artifactActionsClient';
import { ArtifactEditProposal, type AdmittedDocRead } from './ArtifactEditProposal';
import { readDocPassageThreadQuote, type DocPassageMarginThread } from './docPassageMargin';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { artifactViewRoute } from './artifactBrowserModel';

/**
 * One passage thread beside its passage in the Doc (C5 lab K1-A/R/ST): the passage it is about, the
 * comment that started it in the Discussion's own message anatomy, the latest reply, and
 * the thread's suggested edit — its card while open, its one-line receipt (with Undo) once decided.
 * A passage that changed keeps its old quote and leads to the revision it was written against.
 */
export function ArtifactPassageThreadCard(
  props: Readonly<{
    thread: DocPassageMarginThread<DiscussionOpenedMessageV1>;
    focused: boolean;
    /** This thread is being re-attached: the Doc is waiting for the text it now belongs to. */
    attaching: boolean;
    client: ArtifactActionsClient;
    docRead: AdmittedDocRead;
    mountThread: (discussionId: string) => () => void;
    viewerAccountId: string;
    onFocus: () => void;
    onOpen: () => void;
    onOpenHistory: (compareFromBodyVersion: number) => void;
    onReattach: () => void;
    onCancelReattach: () => void;
    /** The Doc's body shows this thread's suggestion in place; its card then carries no diff. */
    diffInBody?: boolean;
    waitingApprovalId?: string | null;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { thread } = props;
  React.useEffect(() => props.mountThread(thread.discussionId), [props.mountThread, thread.discussionId]);
  const labels = React.useMemo(
    () =>
      new Map(
        [thread.root, ...thread.replies].flatMap((message) =>
          message.authorAccountId
            ? [
                [
                  message.authorAccountId,
                  resolveDiscussionMessageAuthorLabel(message),
                ] as const,
              ]
            : [],
        ),
      ),
    [thread],
  );
  const resolveAccountLabel = React.useCallback(
    (accountId: string) =>
      accountId === props.viewerAccountId
        ? t('artifacts.browser.passage.you')
        : (labels.get(accountId) ?? null),
    [labels, props.viewerAccountId],
  );
  const root = thread.root;
  const latestReply =
    [...thread.replies]
      .reverse()
      .find((message) => message !== thread.proposal) ?? null;
  const detached = thread.location.state === 'detached';
  // A thread re-attached to new text keeps what it was first written on, visible beside its new quote.
  const reattached = thread.passage !== thread.original;
  // Who suggested the edit, named as the thread names them: an agent by its Session, a person by name.
  // A Workflow Run is neither; it can't be asked to redo, so it names no proposer to address.
  // An agent's message speaks as its Session (C7), in the latest-reply line as in the proposal title.
  const serverId = root.messageRef.discussion.serverId;
  const speakerMessages = React.useMemo(
    () => [root, ...thread.replies],
    [root, thread.replies],
  );
  const speakerSessionIds = React.useMemo(
    () => [
      ...new Set(
        speakerMessages.flatMap((message) =>
          [...(message.producerV1?.kind === 'agent' ? [message.producerV1.sessionId] : []),
            ...(message.content ? readDiscussionMentionedParticipantIdsV1(message.content).mentionedSessionIds : [])],
        ),
      ),
    ],
    [speakerMessages],
  );
  const producerAddresses = React.useMemo(
    () => speakerSessionIds.map((sessionId) => ({ serverId, sessionId })),
    [serverId, speakerSessionIds],
  );
  const requesterApprovals = useDiscussionRequesterApprovals(root.messageRef.discussion, producerAddresses);
  const producerTitles = useSessionDisplayNameProjections(producerAddresses, useDiscussionSessionLabelProjection());
  const producerLabels = React.useMemo(
    () => new Map(speakerSessionIds.map((sessionId, index) => [sessionId, producerTitles[index] ?? null])),
    [producerTitles, speakerSessionIds],
  );
  const resolveSessionLabel = React.useCallback((sessionId: string) => producerLabels.get(sessionId) ?? null, [producerLabels]);
  // An Agent's message wears its Agent's mark, as in the Discussion, never the face of the Account that runs it.
  const producerAgentIds = useSessionDisplayNameProjections(producerAddresses, useDiscussionSessionAgentIdProjection());
  const readAgentId = (message: DiscussionOpenedMessageV1) => message.producerV1?.kind === 'agent'
    ? producerAgentIds[speakerSessionIds.indexOf(message.producerV1.sessionId)] ?? null : null;
  const resolveSpeakerLabel = React.useCallback(
    (message: DiscussionOpenedMessageV1) =>
      resolveDiscussionMessageSpeakerLabel(message, {
        account: resolveAccountLabel,
        session: resolveSessionLabel,
        workflowRun: () => null,
      }),
    [resolveSessionLabel, resolveAccountLabel],
  );
  const proposer = React.useMemo(() => {
    const message = thread.proposal;
    if (!message) return null;
    const speakerLabel = resolveSpeakerLabel(message);
    if (message.producerV1?.kind === 'agent') return { label: speakerLabel, mention: { sessionId: message.producerV1.sessionId } };
    if (message.producerV1) return null;
    return message.authorAccountId ? { label: speakerLabel, mention: { accountId: message.authorAccountId } } : null;
  }, [resolveSpeakerLabel, thread.proposal]);
  const testID = `artifact:passage-thread:${thread.discussionId}`;
  const proposalContent =
    thread.proposal?.content &&
    'kind' in thread.proposal.content &&
    thread.proposal.content.kind === 'doc_edit_proposal'
      ? thread.proposal.content.proposal
      : null;
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        props.focused
          ? { borderColor: theme.colors.state.active.border }
          : null,
      ]}
    >
      <View style={styles.quoteRow}>
        <Pressable
          testID={`${testID}.focus`}
          accessibilityRole="button"
          accessibilityState={{ selected: props.focused }}
          onPress={props.onFocus}
          style={styles.quotePress}
        >
          <Icon
            name="quotes"
            size={ICON_SIZE.xs}
            color={theme.colors.text.tertiary}
          />
          <Text variant="meta" numberOfLines={1} style={styles.quote}>
            {readDocPassageThreadQuote(thread)}
          </Text>
          {detached ? (
            <Text
              testID={`${testID}.changed`}
              variant="meta"
              emphasis="medium"
              style={{ color: theme.colors.state.warning.textForeground }}
            >
              {t('artifacts.browser.passage.changed')}
            </Text>
          ) : null}
        </Pressable>
        <HappierPressable
          testID={`${testID}.open`}
          accessibilityRole="link"
          accessibilityLabel={t('artifacts.browser.passage.openConversation')}
          onPress={props.onOpen}
          style={({ pressed }) => [
            styles.open,
            pressed ? { opacity: 0.6 } : null,
          ]}
        >
          <Icon
            name="arrow-square-out"
            size={ICON_SIZE.xs}
            color={theme.colors.text.tertiary}
          />
        </HappierPressable>
      </View>
      {reattached ? (
        <Text testID={`${testID}.earlier`} variant="meta" numberOfLines={1} style={styles.earlier}>
          {t('artifacts.browser.passage.earlier', {
            n: thread.original.revision.bodyVersion,
            quote: thread.original.quote,
          })}
        </Text>
      ) : null}
      <Pressable onPress={props.onFocus} accessible={false}>
      <HappierThreadMessage
        startsGroup
        space={theme.space}
        selectionColors={theme.colors.state.active}
        style={styles.message}
        face={
          <DiscussionSpeakerFace message={root} serverId={serverId} viewerAccountId={props.viewerAccountId}
            agentId={readAgentId(root)} size={24} markSize={ICON_SIZE.md} testID={(kind) => `${testID}.face-${kind}`} />
        }
        attribution={
          <>
            <Text style={styles.author}>
              {resolveSpeakerLabel(root)}
            </Text>
            {root.createdAt > 0 ? (
              <Text style={styles.timestamp}>
                {formatShortRelativeTime(root.createdAt)}
              </Text>
            ) : null}
          </>
        }
      >
        <DiscussionMessageContent message={root} serverId={root.messageRef.discussion.serverId}
          resolveAccountLabel={resolveAccountLabel} resolveSessionLabel={resolveSessionLabel} textStyle={styles.text} />
      </HappierThreadMessage>
      </Pressable>
      {latestReply ? (
        <Pressable
          testID={`${testID}.reply`}
          onPress={props.onOpen}
          style={styles.replyRow}
        >
          <DiscussionSpeakerFace message={latestReply} serverId={serverId} viewerAccountId={props.viewerAccountId}
            agentId={readAgentId(latestReply)} size={16} markSize={ICON_SIZE.sm} testID={(kind) => `${testID}.reply.face-${kind}`} />
          <View style={styles.replyContent}>
            <Text variant="meta" numberOfLines={1} style={styles.replyText}>
              {t('artifacts.browser.passage.replied', {
                name:
                  resolveSpeakerLabel(latestReply),
                time: formatShortRelativeTime(latestReply.createdAt),
              })}
            </Text>
            <DiscussionMessageContent message={latestReply} serverId={serverId}
              resolveAccountLabel={resolveAccountLabel} resolveSessionLabel={resolveSessionLabel} textStyle={styles.text} />
          </View>
        </Pressable>
      ) : null}
      {props.waitingApprovalId ? <DiscussionWaitingApprovalCard approvalId={props.waitingApprovalId} serverId={serverId}
        returnHref={artifactViewRoute(thread.passage.ref.artifactId)} /> : null}
      {requesterApprovals.map(approval => <ApprovalRequesterThreadCard key={approval.artifact.id} approval={approval}
        serverId={serverId} returnHref={artifactViewRoute(thread.passage.ref.artifactId)} />)}
      {detached ? (
        <View testID={`${testID}.detached`} style={styles.notice}>
          <View style={styles.noticeLine}>
          <Icon
            name="clock-counter-clockwise"
            size={ICON_SIZE.sm}
            color={theme.colors.text.secondary}
          />
          <Text variant="meta" style={styles.noticeText}>
            {t('artifacts.browser.passage.changedReason', {
              n: thread.quoteRevision.bodyVersion,
            })}
          </Text>
          </View>
          {props.attaching ? (
            <>
              <Text testID={`${testID}.reattaching`} variant="meta" accessibilityLiveRegion="polite" style={styles.noticeText}>
                {t('artifacts.browser.passage.reattaching')}
              </Text>
              <View style={styles.noticeActions}>
                <RoundButton
                  testID={`${testID}.reattach-cancel`}
                  size="small"
                  display="inverted"
                  title={t('common.cancel')}
                  textStyle={{ color: theme.colors.text.primary }}
                  onPress={props.onCancelReattach}
                />
              </View>
            </>
          ) : (
            <View style={styles.noticeActions}>
              <RoundButton
                testID={`${testID}.compare`}
                size="small"
                display="inverted"
                title={t('artifacts.browser.passage.openRevision', {
                  n: thread.quoteRevision.bodyVersion,
                })}
                textStyle={{ color: theme.colors.text.primary }}
                onPress={() => props.onOpenHistory(thread.quoteRevision.bodyVersion)}
              />
              <RoundButton
                testID={`${testID}.reattach`}
                size="small"
                title={t('artifacts.browser.passage.reattach')}
                onPress={props.onReattach}
              />
            </View>
          )}
        </View>
      ) : null}
      {thread.proposal && proposalContent ? (
        <ArtifactEditProposal
          testID={`${testID}.proposal`}
          client={props.client}
          docRead={props.docRead}
          proposalRef={thread.proposal.messageRef ?? null}
          proposal={proposalContent}
          disposition={thread.proposal.docEditProposalDispositionV1}
          viewerAccountId={props.viewerAccountId}
          resolveAccountLabel={resolveAccountLabel}
          proposer={proposer}
          namesProposer
          diffInBody={props.diffInBody}
        />
      ) : null}
      {/* The reply composer closes the thread: after the message, its outcome and any notice, never between them. */}
      {props.focused ? <ArtifactPassageThreadReply serverId={serverId} discussionId={thread.discussionId}
        resolveAccountLabel={resolveAccountLabel} resolveSessionLabel={resolveSessionLabel} onOpen={props.onOpen} /> : null}
    </View>
  );
}

/**
 * A thread card while the Doc's threads are still on their way (lab L8 ST loading): the card's own frame
 * with three placeholder rows, so the comments column reads as coming rather than empty.
 */
export function ArtifactPassageThreadCardPlaceholder(): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <View testID="artifact:comments.loading" style={styles.card}>
      <SkeletonRows rows={3} accessibilityLabel={t('artifacts.browser.passage.threadsTitle')}
        geometry={{ insetStart: 0, insetEnd: 0, glyphColumn: ICON_SIZE.sm, glyphSize: ICON_SIZE.sm, gap: theme.space.s10 }} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.base,
    paddingVertical: theme.space.s12,
    paddingHorizontal: theme.space.s12,
    gap: theme.space.s8,
  },
  quoteRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  quotePress: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  quote: { flex: 1, minWidth: 0, color: theme.colors.text.tertiary },
  open: { padding: theme.space.s2 },
  message: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
  author: {
    color: theme.colors.text.primary,
    ...Typography.variant('label', 'semiBold'),
  },
  timestamp: {
    color: theme.colors.text.tertiary,
    ...Typography.variant('meta'),
    fontVariant: ['tabular-nums'],
  },
  text: { color: theme.colors.text.primary, ...Typography.variant('body') },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingLeft: theme.space.s32 + theme.space.s2,
  },
  replyContent: { flex: 1, minWidth: 0 },
  replyText: { color: theme.colors.text.secondary },
  noticeLine: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s8 },
  noticeActions: { flexDirection: 'row', alignSelf: 'flex-end', gap: theme.space.s8 },
  earlier: { color: theme.colors.text.tertiary },
  notice: {
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
    paddingHorizontal: theme.space.s10,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.inset,
  },
  noticeText: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
}));
