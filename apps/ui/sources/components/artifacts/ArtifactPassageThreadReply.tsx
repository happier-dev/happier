import * as React from 'react';
import { View } from 'react-native';
import type { DiscussionParticipantRefV1 } from '@happier-dev/protocol/discussions/references';
import { DiscussionComposer, type DiscussionComposerValue } from '@/components/discussions/DiscussionComposer';
import { discussionFailureLabel } from '@/components/discussions/discussionFailureLabel';
import { prepareDiscussionParticipantMentions, type DiscussionParticipantMentionPreparation } from '@/components/discussions/prepareDiscussionParticipantMentions';
import { createDiscussionPassageBadge, createDiscussionReplyBadge } from '@/components/discussions/discussionComposerContextItems';
import { resolveDiscussionMessageSpeakerLabel, projectDiscussionMessageReferences } from '@/components/discussions/discussionTimelineProjection';
import { useDiscussionDraft } from '@/components/discussions/useDiscussionDraft';
import { useDiscussionParticipantManagement } from '@/components/discussions/useDiscussionParticipantManagement';
import { useDiscussionPost } from '@/components/discussions/useDiscussionPost';
import { useDiscussionRecipientSelection } from '@/components/discussions/useDiscussionRecipientSelection';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionComposerSnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { t } from '@/text';

/** Selecting an existing passage thread opens the same private draft and post lifecycle as its page. */
export function ArtifactPassageThreadReply(props: Readonly<{
    serverId: string;
    discussionId: string;
    resolveAccountLabel(accountId: string): string | null;
    resolveSessionLabel(sessionId: string): string | null;
    onOpen(): void;
}>) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    return binding ? <Reply key={JSON.stringify([binding.scope.serverId, binding.scope.accountId, props.discussionId])}
        {...props} binding={binding} /> : null;
}

function Reply(props: Readonly<{
    binding: ServerCredentialAccountScopeBinding;
    discussionId: string;
    resolveAccountLabel(accountId: string): string | null;
    resolveSessionLabel(sessionId: string): string | null;
    onOpen(): void;
}>) {
    const { binding, discussionId } = props;
    const address = React.useMemo(() => ({ serverId: binding.scope.serverId }), [binding.scope.serverId]);
    const client = React.useMemo(() => createDiscussionClient({ scope: binding.scope, availability: 'available' }), [binding.scope]);
    const repository = React.useMemo(() => getDiscussionRepository({ scope: binding.scope, address, client, accountLifetime: binding }),
        [address, binding, client]);
    const snapshot = useDiscussionComposerSnapshot(repository, discussionId);
    const summary = snapshot.thread?.summary ?? null;
    const draftAddress = React.useMemo(() => ({ kind: 'discussion' as const, discussionId }), [discussionId]);
    const draft = useDiscussionDraft({ scope: binding.scope, address: draftAddress });
    const participants = useDiscussionParticipantManagement({ accountLifetime: binding, discussionId, repository, summary,
        enabled: snapshot.thread?.status !== 'revoked' });
    const roster = participants.roster;
    const label = React.useCallback((participant: DiscussionParticipantRefV1) => {
        if (participant.kind === 'session') return props.resolveSessionLabel(participant.sessionId)
            ?? t('session.collaboration.discussion.participants.session');
        const grant = roster?.grants.find(entry => entry.principal.kind === 'account' && entry.principal.accountId === participant.accountId);
        return props.resolveAccountLabel(participant.accountId) ?? grant?.display.name ?? grant?.display.username ?? t('session.collaboration.unnamed');
    }, [props.resolveAccountLabel, props.resolveSessionLabel, roster?.grants]);
    const recipients = useDiscussionRecipientSelection({ draft, roster, label });
    const postable = summary?.archivedAt === null && summary.capabilities.postMessages;
    const { mutation, composerBlocked, send, dismissRefusal } = useDiscussionPost({ scope: binding.scope, discussionId, repository,
        mutations: snapshot.mutations, messages: snapshot.thread?.messages ?? [], draft, draftAddress,
        canPost: postable, recipientSelection: recipients });
    const [mentionFailure, setMentionFailure] = React.useState<Extract<DiscussionParticipantMentionPreparation, { kind: 'refused' }>['outcome'] | null>(null);
    const prepareParticipantMentions = React.useCallback(async (document: DiscussionComposerValue, isCurrent: () => boolean) => {
        setMentionFailure(null);
        const result = await prepareDiscussionParticipantMentions({ document, discussionId, repository, inviteExecutable: participants.inviteExecutable,
            isCurrent: () => binding.isCurrent() && isCurrent() });
        if (result.kind === 'ready') return result.content;
        if (binding.isCurrent() && isCurrent()) setMentionFailure(result.outcome);
        return null;
    }, [binding, discussionId, participants.inviteExecutable, repository]);
    const value = React.useMemo(() => ({ text: draft.text, mentions: draft.mentions }), [draft.mentions, draft.text]);
    const contextItems = React.useMemo(() => {
        const items: ReturnType<typeof createDiscussionReplyBadge>[] = [];
        if (draft.replyTarget?.kind === 'message') {
            const messageId = draft.replyTarget.messageId;
            const message = snapshot.thread?.messages.find(item => item.id === messageId);
            items.push(createDiscussionReplyBadge({
                authorLabel: message ? resolveDiscussionMessageSpeakerLabel(message, { account: props.resolveAccountLabel,
                    session: props.resolveSessionLabel, workflowRun: () => null }) : null,
                text: message?.content ? projectDiscussionMessageReferences(message.content, {
                    account: props.resolveAccountLabel, session: props.resolveSessionLabel }).readableText : null,
                onOpen: props.onOpen, onRemove: () => draft.setReplyTarget(null),
            }));
        }
        if (draft.passage) items.push(createDiscussionPassageBadge({ passage: draft.passage,
            onOpen: props.onOpen, onRemove: () => draft.setPassage(null) }));
        return items;
    }, [draft.passage, draft.replyTarget, draft.setPassage, draft.setReplyTarget, props.onOpen, props.resolveAccountLabel, props.resolveSessionLabel, snapshot.thread?.messages]);
    const unavailable = draft.status === 'offline' || draft.status === 'error' || draft.status === 'conflict'
        || snapshot.thread?.status === 'offline' || snapshot.thread?.status === 'locked' || snapshot.thread?.status === 'error';
    if (!postable) return null;
    const failed = mutation?.status === 'failed';
    const unknown = mutation?.status === 'outcome_unknown';
    return <View testID={`artifact:passage-thread:${discussionId}.composer`}>
        {mentionFailure ? <SurfaceStateCard size="line" kind="warning" title={mentionFailure.kind === 'failed' ? discussionFailureLabel(mentionFailure.errorCode)
            : mentionFailure.kind === 'approval_request_created' ? t('approvals.status.open') : t('session.collaboration.discussion.deliveryUnknown')}
            action={{ label: t('artifacts.browser.passage.openConversation'), onPress: props.onOpen }} /> : null}
        {mutation && (failed || unknown) ? <SurfaceStateCard size="line" kind="warning"
            title={failed ? discussionFailureLabel(mutation.errorCode) : t('session.collaboration.discussion.deliveryUnknown')}
            action={failed && mutation.recovery === 'dismiss'
                ? { label: t('session.collaboration.discussion.dismiss'), onPress: dismissRefusal }
                : { label: t('session.collaboration.discussion.retry'), onPress: () => { void repository.retry(mutation.localId); } }} /> : null}
        <DiscussionComposer scope={binding.scope} accountLifetime={binding} address={address} discussionId={discussionId}
            roster={roster} onRefreshParticipants={participants.refresh} availability="available"
            disabled={composerBlocked || unavailable} value={value} onChange={draft.setComposer}
            onSend={(content, attachments) => { void send(content, attachments); }} draftAddress={draftAddress}
            prepareParticipantMentions={prepareParticipantMentions} recipients={recipients} contextItems={contextItems} focusOnOpen
            placeholder={t('artifacts.browser.passage.replyPlaceholder')} />
    </View>;
}
