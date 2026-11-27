import * as React from 'react';
import { canonicalSessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { deriveDocCommentDiscussionCreationLocalIdV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import {
  readDiscussionMentionedParticipantIdsV1,
  readDiscussionMessagePartsV1,
  type DiscussionMessageContentV1,
} from '@happier-dev/protocol/discussions/content';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import {
  discussionMutationBlocksComposer,
  isDiscussionSourceContentRefusal,
} from '@/sync/ops/discussions/discussionRepository';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { t } from '@/text';

import {
  readDiscussionContentPassage,
  resolveDiscussionCreationTitle,
} from './discussionComposerDocument';
import type {
  DiscussionDetailsTarget,
  DiscussionHomeAddress,
} from './discussionDetailsTarget';
import {
  useDiscussionAttachmentSettlement,
  type DiscussionAttachmentSendSubmission,
} from './useDiscussionAttachmentDrafts';
import { useDiscussionDraft } from './useDiscussionDraft';

/** The Home's Discussion repository for this Account, mounted on one Discussion or on the list. */
export function useDiscussionRepository(
  scope: ServerAccountScope,
  address: DiscussionHomeAddress,
  accountLifetime: ServerCredentialAccountScopeBinding,
  discussionId?: string,
  active = true,
): readonly [
  DiscussionRepository,
  ReturnType<DiscussionRepository['getSnapshot']>,
  ReturnType<typeof createDiscussionClient>,
] {
  const client = React.useMemo(
    () => createDiscussionClient({ scope, availability: 'available' }),
    [scope],
  );
  const repository = React.useMemo(
    () =>
      getDiscussionRepository({
        scope,
        address,
        client,
        accountLifetime,
      }),
    [accountLifetime, address, client, scope],
  );
  const snapshot = useDiscussionRepositorySnapshot(repository);
  React.useEffect(
    () =>
      repository.mount(
        discussionId
          ? { discussionId, projection: active ? undefined : 'summary' }
          : undefined,
      ),
    [active, discussionId, repository],
  );
  return [repository, snapshot, client];
}

/**
 * Creating a Discussion from its `newDiscussion` draft: the one create path for the new-Discussion page and
 * a Doc's inline comment. The first message and title go out as one create with stable local ids; a retry
 * reuses them, a refusal mints fresh ones, and confirmation activates the thread before local draft cleanup.
 */
export function useNewDiscussionCreate(
  params: Readonly<{
    scope: ServerAccountScope;
    address: DiscussionHomeAddress;
    accountLifetime: ServerCredentialAccountScopeBinding;
    draftId?: string;
    anchor?: Extract<DiscussionDetailsTarget, { kind: 'new' }>['anchor'];
    onCreated?: (
      discussion: DiscussionOpenedSummaryV1,
      passageRoot?: DiscussionMessageRefV1,
    ) => void;
  }>,
) {
  const draftAddress = React.useMemo(
    () => ({
      kind: 'newDiscussion' as const,
      ...(params.draftId === undefined ? {} : { draftId: params.draftId }),
    }),
    [params.draftId],
  );
  const draft = useDiscussionDraft({
    scope: params.scope,
    address: draftAddress,
    composer: false,
  });
  const [repository, snapshot] = useDiscussionRepository(
    params.scope,
    params.address,
    params.accountLifetime,
  );
  const restoredAttempt =
    draft.pendingMutationAttempt?.kind === 'create'
      ? draft.pendingMutationAttempt
      : null;
  const ids = React.useRef({
    creationLocalId: restoredAttempt?.creationLocalId ?? randomUUID(),
    messageLocalId: restoredAttempt?.messageLocalId ?? randomUUID(),
  });
  const capture = React.useRef<ReturnType<
    typeof draft.captureSubmittedCurrentness
  > | null>(null);
  const completed = React.useRef(false);
  const createdNotified = React.useRef(false);
  const [titleRequired, setTitleRequired] = React.useState(false);
  const draftKey = canonicalSessionDraftAddressV2(draftAddress);
  const recoveredMutation =
    Object.values(snapshot.mutations).find(
      (item) =>
        item.kind === 'create' &&
        (item.draftSubmission
          ? canonicalSessionDraftAddressV2(item.draftSubmission.address) ===
            draftKey
          : params.draftId === undefined),
    ) ?? null;
  const activeCreationLocalId =
    recoveredMutation?.localId ?? ids.current.creationLocalId;
  const mutation = snapshot.mutations[activeCreationLocalId] ?? null;
  const composerBlocked = discussionMutationBlocksComposer(mutation);
  const accessRevoked =
    snapshot.lists.active.status === 'revoked' ||
    snapshot.lists.archived.status === 'revoked';
  const sourceRefused =
    draft.passage !== null &&
    mutation?.status === 'failed' &&
    isDiscussionSourceContentRefusal(mutation.errorCode) &&
    mutation.content !== null &&
    mutation.content !== undefined &&
    sameStrictJsonValue(
      readDiscussionContentPassage(mutation.content),
      draft.passage,
    );
  const draftUnavailable =
    draft.status === 'offline' ||
    draft.status === 'error' ||
    draft.status === 'conflict';
  const repositoryUnavailable =
    snapshot.lists.active.status === 'offline' ||
    snapshot.lists.active.status === 'locked' ||
    snapshot.lists.active.status === 'error';
  const composerDisabled = draftUnavailable || repositoryUnavailable;
  const createDisabled = composerBlocked || composerDisabled;
  const createUnavailableLabel =
    draft.status === 'offline' || snapshot.lists.active.status === 'offline'
      ? t('session.collaboration.discussion.offline')
      : snapshot.lists.active.status === 'locked'
        ? t('session.access.preparing')
        : // The draft is retained locally and the conversation still works:
          // the only lost capability is syncing this draft to other devices.
          draft.status === 'unsupported'
          ? t('sessionDrafts.status.unsupported')
          : draft.status === 'error' || snapshot.lists.active.status === 'error'
            ? t('session.collaboration.discussion.loadError')
            : null;
  const onCreated = params.onCreated;
  const finish = React.useCallback(
    async function finish(discussion: DiscussionOpenedSummaryV1) {
      if (completed.current) return;
      completed.current = true;
      const submitted =
        repository.getSnapshot().mutations[activeCreationLocalId]
          ?.draftSubmission ?? capture.current;
      const root = repository
        .getSnapshot()
        .threads[discussion.id]?.messages.find(
          (message) => message.replyTarget?.kind === 'doc_passage',
        );
      // Route replacement follows confirmed creation; local draft cleanup is persistence work.
      repository.acknowledgeObservedSuccess(activeCreationLocalId);
      const cleanup = submitted ? draft.clearAfterObservedSuccess(submitted, discussion.id) : undefined;
      if (!createdNotified.current) {
        createdNotified.current = true;
        onCreated?.(discussion, root?.messageRef);
      }
      try {
        await cleanup;
      } catch {
        // The create is committed. Retry only its local clear, never the create,
        // and keep observation effects from repeatedly retrying a failed device write.
        Modal.alert(t('common.error'), t('errors.operationFailed'), [
          {
            text: t('common.retry'),
            onPress: () => {
              completed.current = false;
              void finish(discussion);
            },
          },
        ]);
        return;
      }
    },
    [activeCreationLocalId, draft, onCreated, repository],
  );
  // The repository's own settled create names its thread. The Home list never lists an item's or a Doc's
  // comments, so for an anchored first comment that settled create is the only place the new thread appears.
  const createdSummary =
    mutation?.status === 'observed_success' && mutation.discussionId
      ? (snapshot.threads[mutation.discussionId]?.summary ?? null)
      : null;
  React.useEffect(() => {
    const found =
      createdSummary ??
      [...snapshot.lists.active.items, ...snapshot.lists.archived.items].find(
        (item) => item.creationLocalId === activeCreationLocalId,
      );
    if (found) void finish(found);
  }, [
    activeCreationLocalId,
    createdSummary,
    finish,
    snapshot.lists.active.items,
    snapshot.lists.archived.items,
  ]);
  React.useEffect(() => {
    if (!restoredAttempt || snapshot.mutations[restoredAttempt.creationLocalId])
      return;
    if (draft.submitted?.attemptLocalId !== restoredAttempt.creationLocalId)
      return;
    const content = draft.submitted.content;
    const title = draft.submitted.title;
    if (!title) return;
    repository.adoptPendingIntent({
      kind: 'create',
      creationLocalId: restoredAttempt.creationLocalId,
      messageLocalId: restoredAttempt.messageLocalId,
      title,
      content,
      ...readDiscussionMentionedParticipantIdsV1(content),
      ...(restoredAttempt.anchor ? { anchor: restoredAttempt.anchor } : {}),
      ...(restoredAttempt.participants
        ? { participants: restoredAttempt.participants }
        : {}),
      ...(restoredAttempt.replyTarget
        ? { replyTarget: restoredAttempt.replyTarget }
        : {}),
      draftSubmission: {
        scope: params.scope,
        address: draftAddress,
        currentness: restoredAttempt.currentness,
      },
    });
  }, [
    draft.submitted,
    draftAddress,
    params.scope,
    repository,
    restoredAttempt,
    snapshot.mutations,
  ]);
  const dismissRefusal = React.useCallback(() => {
    if (mutation?.status !== 'failed') return;
    draft.releaseSubmittedAttempt();
    repository.dismissFailure(mutation.localId);
    createdNotified.current = false;
    // A refused identity is never reused: the retained draft goes out as a fresh attempt.
    ids.current = {
      creationLocalId: randomUUID(),
      messageLocalId: randomUUID(),
    };
  }, [draft, mutation, repository]);
  const trackAttachments = useDiscussionAttachmentSettlement(
    snapshot.mutations,
  );
  const anchor = params.anchor;
  const serverId = params.scope.serverId;
  const submit = React.useCallback(
    async (
      textContent: DiscussionMessageContentV1,
      attachments?: DiscussionAttachmentSendSubmission,
    ) => {
      if (composerBlocked) {
        attachments?.settle('failed', 'canceled');
        return;
      }
      const content = draft.prepareContent(textContent);
      const title = resolveDiscussionCreationTitle({
        title: draft.title,
        text: readDiscussionMessagePartsV1(content)
          .map((part) => (part.t === 'text' ? part.text : ''))
          .join(''),
      });
      if (!title) {
        setTitleRequired(true);
        attachments?.settle('failed', 'canceled');
        return;
      }
      setTitleRequired(false);
      if (mutation) dismissRefusal();
      if (draft.passage)
        ids.current = {
          ...ids.current,
          creationLocalId: deriveDocCommentDiscussionCreationLocalIdV1({
            ref: { ...draft.passage.ref, serverId },
            localId: ids.current.messageLocalId,
          }),
        };
      // Who the person chose to invite goes with this one create, and its retry reuses them.
      const participants = draft.participants.length
        ? { participants: draft.participants }
        : {};
      const draftSubmission = draft.captureSubmittedCurrentness(
        {
          kind: 'create',
          ...ids.current,
          ...(anchor ? { anchor } : {}),
          ...participants,
        },
        { content, title },
      );
      capture.current = draftSubmission;
      const created = repository.create({
        ...ids.current,
        title,
        content,
        ...readDiscussionMentionedParticipantIdsV1(content),
        ...(anchor ? { anchor } : {}),
        ...participants,
        draftSubmission,
        ...(attachments ? { attachmentSources: attachments.sources } : {}),
      });
      await (attachments
        ? trackAttachments(ids.current.creationLocalId, attachments, created)
        : created);
    },
    [
      anchor,
      composerBlocked,
      dismissRefusal,
      draft,
      mutation,
      repository,
      serverId,
      trackAttachments,
    ],
  );
  const retry = React.useCallback(
    () => void repository.retry(activeCreationLocalId),
    [activeCreationLocalId, repository],
  );
  return {
    draftAddress,
    draft,
    mutation,
    accessRevoked,
    sourceRefused,
    createDisabled,
    composerDisabled,
    createUnavailableLabel,
    titleRequired,
    setTitleRequired,
    dismissRefusal,
    submit,
    retry,
  };
}
