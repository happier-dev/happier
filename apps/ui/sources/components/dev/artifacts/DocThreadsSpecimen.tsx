import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  DocEditProposalV1,
  DocPassageRefV1,
} from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import type { DocEditProposalDispositionV1 } from '@happier-dev/protocol/discussions/models';

import { createArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import type { AdmittedDocRead } from '@/components/artifacts/ArtifactEditProposal';
import { DOC_PASSAGE_MARGIN_WIDTH } from '@/components/artifacts/ArtifactPassageSelection';
import {
  ArtifactPassageThreadCard,
  ArtifactPassageThreadCardPlaceholder,
} from '@/components/artifacts/ArtifactPassageThreadCard';
import type { DocPassageMarginThread } from '@/components/artifacts/docPassageMargin';
import { Text } from '@/components/ui/text/Text';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
  storage,
  useActiveServerAccountScope,
} from '@/sync/domains/state/storage';

/**
 * Dev-only specimen of a Doc's passage threads (lab coordination-v2 `L8-ST`, `L8-A`): the real
 * `ArtifactPassageThreadCard` and its `ArtifactEditProposal` in the Doc's comments column, one frame per
 * state the margin can show — an open current suggestion, a suggestion the Doc moved past, a reader who
 * can't edit, accepted with Undo, declined, a passage that changed, an Agent's latest reply, and loading.
 * Fixture threads stand in for the Discussion repository; the Actions front door answers nothing, so a
 * press shows the card's own refusal rather than reaching a Home.
 */

type Revision = Readonly<{ headerVersion: number; bodyVersion: number }>;

const AGENT_SESSION_ID = 'dev-doc-threads-agent';
const BASE: Revision = { headerVersion: 3, bodyVersion: 14 };
const NEXT: Revision = { headerVersion: 3, bodyVersion: 15 };
const MINUTE = 60_000;
const BEFORE = 'A replay shows two rows with the same key.';
const AFTER =
  'A replay shows one row with a replayed badge; the same key with a different amount or card returns 409.';
const REASON =
  'Idempotent retries changed this behaviour today (update at 14:40).';
const BEN = {
  v: 1 as const,
  accountId: 'dev-doc-ben',
  profile: {
    firstName: 'Ben',
    lastName: 'Okafor',
    username: null,
    name: 'Ben Okafor',
    avatarUrl: null,
  },
};
const NOOP = () => {};
const NO_UNMOUNT = () => NOOP;

function useSpecimenScope() {
  const scope = useActiveServerAccountScope();
  return React.useMemo(
    () => ({
      serverId: scope?.serverId ?? getActiveServerSnapshot().serverId,
      accountId: scope?.accountId ?? 'dev-doc-viewer',
    }),
    [scope?.accountId, scope?.serverId],
  );
}

/** One Agent Session that answers in these threads, so its replies and suggestions carry its title and mark. */
function useSeededAgentSession(serverId: string): void {
  React.useEffect(() => {
    const session = createSessionFixture({
      id: AGENT_SESSION_ID,
      serverId,
      metadataLayoutVersion: 1,
      metadata: { path: '', host: '' },
      ownerMetadataView: {
        name: 'Support runbook',
        host: 'build-box',
        path: '/srv/runbook',
      },
    });
    const row = buildSessionListRenderableFromSession(session);
    const current =
      storage.getState().sessionListRowsByServerId[serverId] ?? {};
    // Never replace a real local entry, even from a dev specimen.
    if (current[AGENT_SESSION_ID]) return;
    storage.setState((state) => ({
      sessionListRowsByServerId: {
        ...state.sessionListRowsByServerId,
        [serverId]: {
          ...(state.sessionListRowsByServerId[serverId] ?? {}),
          [AGENT_SESSION_ID]: row,
        },
      },
    }));
    return () =>
      storage.setState((state) => {
        const rows = { ...(state.sessionListRowsByServerId[serverId] ?? {}) };
        if (rows[AGENT_SESSION_ID] !== row) return state;
        delete rows[AGENT_SESSION_ID];
        return {
          sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId,
            [serverId]: rows,
          },
        };
      });
  }, [serverId]);
}

function buildFrames(
  scope: Readonly<{ serverId: string; accountId: string }>,
  now: number,
) {
  const ref = {
    kind: 'doc' as const,
    artifactId: 'dev-doc-runbook',
    serverId: scope.serverId,
  };
  const passage: DocPassageRefV1 = {
    ref,
    revision: BASE,
    range: { start: 0, end: BEFORE.length },
    quote: BEFORE,
  };
  const proposal: DocEditProposalV1 = {
    target: passage,
    baseRevision: BASE,
    before: BEFORE,
    after: AFTER,
    reason: REASON,
  };
  const message = (
    discussionId: string,
    messageId: string,
    seq: number,
    overrides: Partial<DiscussionOpenedMessageV1>,
  ): DiscussionOpenedMessageV1 => ({
    id: messageId,
    discussionId,
    seq,
    authorAccountId: BEN.accountId,
    accountActor: BEN,
    createdAt: now - (40 - seq) * MINUTE,
    localId: null,
    mentionedAccountIds: [],
    producerV1: null,
    messageRef: {
      kind: 'discussion',
      discussion: { serverId: scope.serverId, discussionId },
      messageId,
    },
    replyTarget: { kind: 'message', messageId: 'root' },
    content: { v: 1, parts: [{ t: 'text', text: '' }] },
    ...overrides,
  });
  const comment = (discussionId: string, text: string) =>
    message(discussionId, 'root', 1, {
      replyTarget: { kind: 'doc_passage', doc: { ref, revision: BASE } },
      content: {
        kind: 'doc_passage_comment',
        passage,
        content: { v: 1, parts: [{ t: 'text', text }] },
      },
    });
  const agentReply = (discussionId: string, text: string) =>
    message(discussionId, 'reply', 2, {
      authorAccountId: scope.accountId,
      accountActor: null,
      producerV1: { v: 1, kind: 'agent', sessionId: AGENT_SESSION_ID },
      content: { v: 1, parts: [{ t: 'text', text }] },
    });
  const suggestion = (
    discussionId: string,
    disposition?: DocEditProposalDispositionV1,
  ) =>
    message(discussionId, 'proposal', 3, {
      authorAccountId: scope.accountId,
      accountActor: null,
      producerV1: { v: 1, kind: 'agent', sessionId: AGENT_SESSION_ID },
      content: { kind: 'doc_edit_proposal', proposal },
      ...(disposition ? { docEditProposalDispositionV1: disposition } : {}),
    });
  const thread = (
    discussionId: string,
    input: Readonly<{
      text: string;
      replies?: readonly DiscussionOpenedMessageV1[];
      proposal?: DiscussionOpenedMessageV1 | null;
      detached?: boolean;
    }>,
  ): DocPassageMarginThread<DiscussionOpenedMessageV1> =>
    ({
      discussionId,
      passage,
      original: passage,
      quote: BEFORE,
      quoteRevision: BASE,
      location: input.detached
        ? { state: 'detached' }
        : { state: 'exact', range: passage.range },
      root: comment(discussionId, input.text),
      replies: input.replies ?? [],
      proposal: input.proposal ?? null,
      acceptedProposal: null,
      suggestion: null,
    }) as DocPassageMarginThread<DiscussionOpenedMessageV1>;
  const read = (
    revision: Revision,
    access: 'owner' | 'view' = 'owner',
  ): AdmittedDocRead =>
    ({
      status: 'ready',
      value: {
        ref,
        openCommentCount: 3,
        artifact: {
          artifactId: ref.artifactId,
          ownerAccountId: scope.accountId,
          access,
          publicAudience: 'none',
          header: { title: 'Support runbook for retries' },
          seq: 1,
          createdAt: now - 2 * 24 * 60 * MINUTE,
          updatedAt: now - 5 * MINUTE,
          body: `${BEFORE} Retries back off for up to a minute.`,
          revision,
        },
      },
    }) as AdmittedDocRead;
  const open = (id: string, disposition?: DocEditProposalDispositionV1) => {
    const proposed = suggestion(id, disposition);
    return thread(id, {
      text: 'Is this still how replays look?',
      replies: [proposed],
      proposal: proposed,
    });
  };
  const decided = { accountId: scope.accountId, atMs: now - 2 * MINUTE };
  return [
    {
      key: 'open',
      title: 'Open suggestion',
      note: 'current revision, Accept / Decline',
      thread: open('dev-doc-open'),
      docRead: read(BASE),
    },
    {
      key: 'conflict',
      title: 'Revision conflict',
      note: 'nothing applied, redo',
      thread: open('dev-doc-conflict'),
      docRead: read(NEXT),
    },
    {
      key: 'readOnly',
      title: 'Can only read',
      note: 'no edit access',
      thread: open('dev-doc-readonly'),
      docRead: read(BASE, 'view'),
    },
    {
      key: 'accepted',
      title: 'Accepted',
      note: 'new revision, Undo',
      thread: open('dev-doc-accepted', {
        state: 'accepted',
        acceptedRevision: NEXT,
        decidedBy: decided,
      }),
      docRead: read(NEXT),
    },
    {
      key: 'declined',
      title: 'Declined',
      note: 'by another person',
      thread: open('dev-doc-declined', {
        state: 'declined',
        decidedBy: { accountId: BEN.accountId, atMs: now - 3 * MINUTE },
      }),
      docRead: read(BASE),
    },
    {
      key: 'changed',
      title: 'Passage changed',
      note: 'open the revision or re-attach',
      thread: thread('dev-doc-changed', {
        text: 'Pending retries show "Retrying…"',
        detached: true,
      }),
      docRead: read(NEXT),
    },
    {
      key: 'reply',
      title: 'Agent reply',
      note: 'latest reply under the comment',
      thread: thread('dev-doc-reply', {
        text: 'Can the agent keep this in sync?',
        replies: [
          agentReply(
            'dev-doc-reply',
            'I can read this document but not propose edits to it.',
          ),
        ],
      }),
      docRead: read(BASE),
    },
  ] as const;
}

export function DocThreadsSpecimen(): React.ReactElement {
  const scope = useSpecimenScope();
  useSeededAgentSession(scope.serverId);
  const [now] = React.useState(() => Date.now());
  const frames = React.useMemo(() => buildFrames(scope, now), [scope, now]);
  // The Actions front door is the boundary to the Home; here it answers nothing, so a press settles as refused.
  const client = React.useMemo(
    () =>
      createArtifactActionsClient(scope, (async () => ({
        ok: false,
        errorCode: 'dev_specimen_offline',
      })) as never),
    [scope],
  );
  const [focused, setFocused] = React.useState<string | null>(null);
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      testID="dev-doc-threads"
    >
      {frames.map((frame) => (
        <View
          key={frame.key}
          style={styles.frame}
          testID={`dev-doc-threads.${frame.key}`}
        >
          <Text variant="label" emphasis="semiBold" style={styles.title}>
            {frame.title}
            <Text
              variant="label"
              style={styles.note}
            >{` · ${frame.note}`}</Text>
          </Text>
          <ArtifactPassageThreadCard
            thread={frame.thread}
            focused={focused === frame.key}
            attaching={false}
            client={client}
            docRead={frame.docRead}
            mountThread={NO_UNMOUNT}
            viewerAccountId={scope.accountId}
            onFocus={() => setFocused(frame.key)}
            onOpen={NOOP}
            onOpenHistory={NOOP}
            onReattach={NOOP}
            onCancelReattach={NOOP}
          />
        </View>
      ))}
      <View style={styles.frame} testID="dev-doc-threads.loading">
        <Text variant="label" emphasis="semiBold" style={styles.title}>
          Loading thread
          <Text variant="label" style={styles.note}>
            {' '}
            · size reserved
          </Text>
        </Text>
        <ArtifactPassageThreadCardPlaceholder />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.base },
  content: {
    padding: theme.space.s24,
    gap: theme.space.s24,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
  frame: { width: DOC_PASSAGE_MARGIN_WIDTH, gap: theme.space.s8 },
  title: { color: theme.colors.text.primary },
  note: { color: theme.colors.text.tertiary },
}));
