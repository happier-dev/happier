import * as React from 'react';
import { Platform } from 'react-native';

import {
  useRouter,
  type Href,
} from '@/components/appShell/workspace/destinationRoute';
import { buildDiscussionRouteHref } from '@/components/discussions/discussionRoutes';
import { resolveDiscussionMessageAuthorLabel, resolveDiscussionMessageSpeakerLabel } from '@/components/discussions/discussionTimelineProjection';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { createArtifactActionsClient } from './artifactActionsClient';
import { isArtifactTextDocument, readArtifactCodeLanguage } from './artifactBrowserModel';
import type { ArtifactPassageMargin } from './ArtifactPassageSelection';
import { ArtifactPassageThreadCard } from './ArtifactPassageThreadCard';
import type { AdmittedDocRead } from './ArtifactEditProposal';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { ArtifactDocumentV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { sumDocPassageOpenCommentCountsV1 } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { buildDocPassageMargin, readDocPassageThreadQuote } from './docPassageMargin';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';
import { useDocPassageThreads } from './useDocPassageThreads';
import { readDocAudience, type DocAudience } from './docAudience';
import { rememberDocReturn } from './docThreadReturn';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { planDocSuggestionPaint } from './docSuggestionPaint';
import { ArtifactNewPassageThread, type DocNewPassageComment } from './ArtifactNewPassageThread';
import { ArtifactPassageThreadCardPlaceholder } from './ArtifactPassageThreadCard';

/** The margin id of a comment being written, before it has a Discussion of its own. */
const NEW_COMMENT_ID_PREFIX = 'new:';

/** One thread in the Doc's comment list: the passage it is about and who started it. */
export type DocThreadListItem = Readonly<{
  id: string;
  quote: string;
  author: string;
  replies: number;
  changed: boolean;
}>;

export type DocCollaboration = Readonly<{
  /** The authorized exact-read count; `null` while unknown or unavailable, never a guessed zero. */
  openCommentCount: number | null;
  /** Whether that count is still loading, authoritatively ready (including zero), or unavailable. */
  commentCountStatus: 'loading' | 'ready' | 'unavailable';
  /** The version whose thread membership is ready; `null` until that list settles. */
  version: number | null;
  /** Who the Doc reaches; `null` while unknown (the header then says nothing about it). */
  audience: DocAudience | null;
  threads: readonly DocThreadListItem[];
  /** Beside the passages: focus the thread there. Without a margin: open it. */
  selectThread: (id: string) => void;
  /** Open suggestions based on the version being read (the header's "1 suggestion"); `null` until threads are read. */
  suggestionCount: number | null;
  /** The suggestion accepted into the version being read, named for the header. */
  accepted: Readonly<{ label: string; atMs: number }> | null;
  margin: ArtifactPassageMargin;
  /** Whether the comments column stands beside the body (a wide web layout); the toolbar list then leaves "none yet" to it. */
  marginShown: boolean;
}>;

/**
 * Comments and suggested edits on a Doc (C5 L8): the passage threads placed against the version
 * being read, the header's comment count and accepted-edit line, and the margin's thread cards.
 * `null` for anything that is not a prose Doc read at a known version.
 */
export function useDocCollaboration(artifact: DecryptedArtifact | null): DocCollaboration | null {
  const scope = useActiveServerAccountScope();
  const openedProse = artifact !== null && typeof artifact.body === 'string';
  const knownDocIdentity = artifact !== null && artifact.body === undefined
    && (artifact.rawHeader ?? artifact.header)?.kind === 'markdown';
  const candidate =
    artifact !== null &&
    artifact.isDecrypted !== false &&
    (openedProse || knownDocIdentity) &&
    !isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header) &&
    !readArtifactCodeLanguage(artifact) &&
    isArtifactTextDocument(artifact)
      ? artifact
      : null;
  const prose = candidate !== null && openedProse
    && candidate.bodyVersion !== undefined ? candidate : null;
  const revisionKey = prose
    ? `${prose.headerVersion}.${prose.bodyVersion}`
    : candidate ? `${candidate.headerVersion}.${candidate.bodyVersion ?? 'pending'}` : '';
  const read = useDocPassageThreads({
    serverId: scope?.serverId ?? '',
    artifactId: candidate?.id ?? '',
  });
  const client = React.useMemo(
    () => (scope ? createArtifactActionsClient(scope) : null),
    [scope],
  );
  const router = useRouter();
  const [audience, setAudience] = React.useState<Readonly<{
    key: string;
    value: DocAudience | null;
  }> | null>(null);
  const marginShown = React.useRef(false);
  const [marginShownState, setMarginShown] = React.useState(false);
  const reportShown = React.useCallback((shown: boolean) => {
    marginShown.current = shown;
    setMarginShown(shown);
  }, []);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  // A comment being written beside its passage (lab K1-S), until its created thread is in the list.
  const [newComment, setNewComment] = React.useState<(DocNewPassageComment & Readonly<{
    artifactId: string; createdId?: string;
  }>) | null>(null);
  // The thread waiting for the text it now belongs to; the Doc's selection hands it the next passage.
  const [attachingId, setAttachingId] = React.useState<string | null>(null);
  const artifactId = candidate?.id ?? null;

  const membership = React.useMemo<Readonly<{
    status: 'loading' | 'ready' | 'unavailable';
    count: number | null;
  }>>(() => {
    if (read.status !== 'ready') return { status: read.status, count: null };
    let count = 0;
    try {
      for (const summary of read.membership ?? []) {
        if (summary.firstMessage === null) continue;
        if (summary.firstMessage === undefined) throw new Error('Doc thread root was not admitted');
        count = sumDocPassageOpenCommentCountsV1(count, summary.openCommentCount);
      }
    } catch { return { status: 'unavailable', count: null }; }
    return { status: 'ready', count };
  }, [read.membership, read.status]);

  const docRead: AdmittedDocRead = React.useMemo(() => {
    if (membership.status !== 'ready') return { status: membership.status };
    // The list can establish membership while the parallel body read is still pending.
    if (!prose || !scope || prose.bodyVersion === undefined) return { status: 'loading' };
    return { status: 'ready', value: { ref: { kind: 'doc', serverId: scope.serverId, artifactId: prose.id },
      artifact: ArtifactDocumentV1Schema.parse({ artifactId: prose.id, ownerAccountId: prose.ownerAccountId, access: prose.access,
        publicAudience: prose.publicAudience, header: prose.rawHeader ?? {}, body: prose.body, provenance: prose.provenance,
        seq: prose.seq, createdAt: prose.createdAt, updatedAt: prose.updatedAt,
        revision: { headerVersion: prose.headerVersion, bodyVersion: prose.bodyVersion } }), openCommentCount: membership.count } };
  }, [membership, prose, scope]);

  const audienceArtifactId = prose?.id ?? null;
  const ownerAccountId = prose?.ownerAccountId;
  const access = prose?.access;
  const publicAudience = prose?.publicAudience;
  React.useEffect(() => {
    if (!client || !audienceArtifactId) return;
    let current = true;
    void readDocAudience({
      current: { artifactId: audienceArtifactId, header: {}, ownerAccountId, access, publicAudience },
      readGrants: async () => {
        const outcome = await client.listAccessGrants(audienceArtifactId);
        if (!outcome.ok) throw new Error(outcome.failure.code);
        return outcome.value;
      },
    }).then((value) => {
      if (current) setAudience({ key: audienceArtifactId, value });
    });
    return () => {
      current = false;
    };
  }, [access, audienceArtifactId, client, ownerAccountId, publicAudience]);

  const model = React.useMemo(
    () =>
      prose && read.status === 'ready' && prose.bodyVersion !== undefined
        ? buildDocPassageMargin({
            source: prose.body as string,
            revision: {
              headerVersion: prose.headerVersion,
              bodyVersion: prose.bodyVersion,
            },
            threads: read.threads,
          })
        : null,
    [prose, read],
  );
  const speakerMessages = React.useMemo(
    () =>
      model?.threads.flatMap((thread) => [thread.root, ...thread.replies]) ?? [],
    [model?.threads],
  );
  const speakerSessionIds = React.useMemo(
    () => [
      ...new Set(
        speakerMessages.flatMap((message) =>
          message.producerV1?.kind === 'agent'
            ? [message.producerV1.sessionId]
            : [],
        ),
      ),
    ],
    [speakerMessages],
  );
  const speakerAccountLabels = React.useMemo(
    () => new Map(speakerMessages.flatMap((message) => message.authorAccountId
      ? [[message.authorAccountId, resolveDiscussionMessageAuthorLabel(message)] as const]
      : [])),
    [speakerMessages],
  );
  const speakerAddresses = React.useMemo(
    () =>
      speakerSessionIds.map((sessionId) => ({
        serverId: scope?.serverId,
        sessionId,
      })),
    [scope?.serverId, speakerSessionIds],
  );
  const speakerTitles = useSessionDisplayTitles(speakerAddresses);
  const speakerLabels = React.useMemo(
    () =>
      new Map(
        speakerSessionIds.map((sessionId, index) => [
          sessionId,
          speakerTitles[index] ?? null,
        ]),
      ),
    [speakerSessionIds, speakerTitles],
  );
  const resolveSpeakerLabel = React.useCallback(
    (message: DiscussionOpenedMessageV1) =>
      resolveDiscussionMessageSpeakerLabel(message, {
        account: (accountId) => speakerAccountLabels.get(accountId) ?? null,
        session: (sessionId) => speakerLabels.get(sessionId) ?? null,
        workflowRun: () => null,
      }),
    [speakerAccountLabels, speakerLabels],
  );
  const canRestore = candidate !== null &&
    (candidate.access === undefined || candidate.access === 'owner' || candidate.access === 'edit' || candidate.access === 'admin');
  const proseName = candidate?.title || t('artifacts.untitled');
  // A changed passage opens History on the version its comment was written against, compared with now.
  const openHistory = React.useCallback((compareFromBodyVersion: number) => {
    if (artifactId && client)
      showArtifactHistorySheet({ artifactId, client, currentDoc: docRead.status === 'ready' ? docRead.value.artifact : undefined,
        name: proseName, canRestore, compareFromBodyVersion });
  }, [artifactId, canRestore, client, docRead, proseName]);
  const open = React.useCallback(
    (discussionId: string) => {
      if (!scope) return;
      // Back from the thread returns to this passage in this Doc.
      if (artifactId) rememberDocReturn(artifactId);
      router.push(
        buildDiscussionRouteHref({
          target: {
            kind: 'discussion',
            address: { serverId: scope.serverId },
            discussionId,
          },
          ...(artifactId ? { returnArtifactId: artifactId } : {}),
        }) as Href,
      );
    },
    [artifactId, router, scope],
  );

  const attach = React.useMemo(
    () =>
      attachingId && client && artifactId
        ? {
            discussionId: attachingId,
            // The captured passage is the thread's next comment basis: its own draft carries it, and the
            // person writes the comment that posts it (`doc.comment.reply` into this thread).
            complete: (passage: DocPassageRefV1) => {
              rememberDocReturn(artifactId);
              setAttachingId(null);
              router.push(
                client.beginPassageReattach({ discussionId: attachingId, passage, returnArtifactId: artifactId }) as Href,
              );
            },
          }
        : null,
    [artifactId, attachingId, client, router],
  );

  const threads = model?.threads;
  const pendingComment = newComment && newComment.artifactId === artifactId
    && !(newComment.createdId && threads?.some((thread) => thread.discussionId === newComment.createdId)) ? newComment : null;
  const pendingId = pendingComment ? `${NEW_COMMENT_ID_PREFIX}${pendingComment.draftId}` : null;
  const startComment = React.useCallback((passage: DocPassageRefV1) => {
    if (!client || !artifactId) return;
    const { draftId } = client.startPassageComment(passage);
    setNewComment({ artifactId, draftId, passage });
    setFocusedId(`${NEW_COMMENT_ID_PREFIX}${draftId}`);
  }, [artifactId, client]);
  // The web body paints each current suggestion where it applies (lab K1-A); a native body keeps the
  // diff on the card until Lab 1 decides the phone thread (COORD-COMPOSE-1107 §5).
  const paint = React.useMemo(() => {
    if (Platform.OS !== 'web' || !prose || typeof prose.body !== 'string' || !threads) return null;
    return planDocSuggestionPaint({
      markdown: prose.body,
      suggestions: threads.flatMap((thread) => thread.suggestion
        ? [{ id: thread.discussionId, range: thread.suggestion.range, after: thread.suggestion.after }] : []),
    });
  }, [prose, threads]);
  const suggestionCount = threads ? threads.filter((thread) => thread.suggestion !== null).length : null;
  const pendingPassage = pendingComment?.passage ?? null;
  const passages = React.useMemo(() => {
    const placed = (threads ?? []).map((thread) => ({ id: thread.discussionId, location: thread.location }));
    if (!pendingId || !pendingPassage) return placed;
    // The new thread stands beside its selection while the Doc is still at the revision it was captured on.
    const current = prose !== null && prose.headerVersion === pendingPassage.revision.headerVersion
      && prose.bodyVersion === pendingPassage.revision.bodyVersion;
    const location = current ? { state: 'exact' as const, range: pendingPassage.range } : { state: 'detached' as const };
    const position = (entry: (typeof placed)[number]) => entry.location.state === 'detached' ? Number.POSITIVE_INFINITY : entry.location.range.start;
    return [...placed, { id: pendingId, location }].sort((left, right) => position(left) - position(right));
  }, [pendingId, pendingPassage, prose, threads]);
  const renderCard = React.useCallback(
    (id: string) => {
      if (id === pendingId && pendingComment && scope) {
        // Sent: the card holds its place until the created thread arrives in the list.
        if (pendingComment.createdId) return <ArtifactPassageThreadCardPlaceholder />;
        const { draftId } = pendingComment;
        return (
          <ArtifactNewPassageThread
            scope={scope}
            comment={pendingComment}
            onCreated={(discussion) => {
              setNewComment((current) => current?.draftId === draftId ? { ...current, createdId: discussion.id } : current);
              setFocusedId(discussion.id);
            }}
            onOpenDiscussion={() => {
              if (artifactId) rememberDocReturn(artifactId);
              router.push(buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: scope.serverId }, draftId } }) as Href);
            }}
            onClose={() => setNewComment(null)}
          />
        );
      }
      const thread = threads?.find(
        (candidate) => candidate.discussionId === id,
      );
      if (!thread || !client || !scope) return null;
      return (
        <ArtifactPassageThreadCard
          thread={thread}
          focused={focusedId === id}
          attaching={attachingId === id}
          onReattach={() => { setFocusedId(id); setAttachingId(id); }}
          onCancelReattach={() => setAttachingId(null)}
          client={client}
          docRead={docRead}
          mountThread={read.mountThread}
          viewerAccountId={scope.accountId}
          onFocus={() => setFocusedId(id)}
          onOpen={() => open(id)}
          onOpenHistory={openHistory}
          diffInBody={paint?.painted.has(id) === true}
        />
      );
    },
    [artifactId, attachingId, client, docRead, focusedId, open, openHistory, paint, pendingComment, pendingId, read.mountThread, router, scope, threads],
  );

  const accepted = React.useMemo(() => {
    const value = model?.accepted;
    if (!value || !scope) return null;
    const proposal =
      model.threads.find(
        (thread) =>
          thread.acceptedProposal?.docEditProposalDispositionV1?.state === 'accepted' &&
          thread.acceptedProposal.docEditProposalDispositionV1.decidedBy.atMs ===
            value.atMs,
      )?.acceptedProposal ?? null;
    const proposer = proposal
      ? resolveSpeakerLabel(proposal)
      : t('session.collaboration.discussion.collaborator');
    const label =
      value.deciderAccountId === scope.accountId
        ? t('artifacts.browser.passage.youAccepted', { name: proposer })
        : t('artifacts.browser.passage.accepted', { name: proposer });
    return { label, atMs: value.atMs };
  }, [model, resolveSpeakerLabel, scope]);

  const viewerAccountId = scope?.accountId ?? null;
  const list = React.useMemo<readonly DocThreadListItem[]>(
    () =>
      (threads ?? []).map((thread) => ({
        id: thread.discussionId,
        quote: readDocPassageThreadQuote(thread),
        author:
          thread.root.producerV1 === null && thread.root.authorAccountId === viewerAccountId
            ? t('artifacts.browser.passage.you')
            : resolveSpeakerLabel(thread.root),
        // The suggested edit has its own line on the card; replies are what people wrote back.
        replies: thread.replies.filter((reply) => reply !== thread.proposal).length,
        changed: thread.location.state === 'detached',
      })),
    [resolveSpeakerLabel, threads, viewerAccountId],
  );
  const selectThread = React.useCallback(
    (id: string) => {
      if (marginShown.current) setFocusedId(id);
      else open(id);
    },
    [open],
  );
  const margin = React.useMemo<ArtifactPassageMargin>(
    () => ({
      passages,
      focusedId,
      onFocus: setFocusedId,
      onOpen: open,
      renderCard,
      reportShown,
      attach,
      paint,
      startComment,
    }),
    [attach, focusedId, open, paint, passages, renderCard, reportShown, startComment],
  );
  if (!candidate || !scope) return null;
  return {
    openCommentCount: membership.count,
    commentCountStatus: membership.status,
    version: membership.status === 'ready' ? candidate.bodyVersion ?? null : null,
    audience: audience && audience.key === candidate.id ? audience.value : null,
    threads: list,
    selectThread,
    suggestionCount,
    accepted,
    margin,
    marginShown: marginShownState,
  };
}
