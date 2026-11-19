import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { Message } from '@happier-dev/session-core/messages';

import { ChatList } from '@/components/sessions/transcript/ChatList';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';

const SESSION_ID = 'dev-transcript-turn-end';
const T0 = 1_763_546_280_000;

/**
 * The real session transcript (ChatList over a local read-only history) in the ideas-1118-shell scene 2 states:
 * a turn that changed nothing ("Worked for 2m 05s" alone), the "New" divider at the read cursor, and a turn whose
 * line sits above its changes card ("Worked for 1m 12s"). `?stopped=1` ends the second turn cancelled, with no changes card, so its line is the last row.
 */
function createMessages(withChanges: boolean): readonly Message[] {
  const persistedId = (id: string) => `devturnend${id}`;
  const user = (seq: number, text: string): Message => ({
    kind: 'user-text',
    id: `m${seq}`,
    realID: persistedId(`m${seq}`),
    localId: null,
    seq,
    createdAt: T0 + seq * 60_000,
    text,
  });
  const agent = (seq: number, text: string): Message => ({
    kind: 'agent-text',
    id: `m${seq}`,
    realID: persistedId(`m${seq}`),
    localId: null,
    seq,
    createdAt: T0 + seq * 60_000,
    text,
  });
  const file = (path: string, added: number, removed: number) => ({
    file_path: path,
    source: 'scm_checkpoint',
    unified_diff: [
      `@@ -1,${removed} +1,${added} @@`,
      ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
      ...Array.from({ length: added }, (_, i) => `+new ${i}`),
    ].join('\n'),
  });
  const diff: Message = {
    kind: 'tool-call',
    id: 'm5',
    realID: persistedId('m5'),
    localId: null,
    seq: 5,
    createdAt: T0 + 5 * 60_000,
    children: [],
    tool: {
      id: 'tool-m5',
      name: 'Diff',
      state: 'completed',
      createdAt: T0 + 5 * 60_000,
      startedAt: T0 + 5 * 60_000,
      completedAt: T0 + 5 * 60_000,
      description: null,
      result: null,
      input: {
        _happier: {
          v: 2,
          protocol: 'claude',
          rawToolName: 'Diff',
          canonicalToolName: 'Diff',
          sessionChangeScope: 'turn',
          sessionId: SESSION_ID,
          turnId: 'turn-2',
          provider: 'claude',
          source: 'scm_checkpoint',
          confidence: 'exact',
          turnStatus: 'completed',
          seqRange: { startSeqInclusive: 3, endSeqInclusive: 5 },
        },
        files: [
          file(
            'apps/ui/sources/sync/ops/sessionDrafts/sessionDraftRepository.ts',
            96,
            18,
          ),
          file(
            'apps/ui/sources/components/sessions/composer/useComposerDraft.ts',
            64,
            12,
          ),
          file(
            'apps/ui/sources/components/sessions/composer/ComposerAttachments.tsx',
            38,
            8,
          ),
          file(
            'apps/ui/sources/sync/ops/sessionDrafts/sessionDraftRepository.test.ts',
            14,
            2,
          ),
        ],
      },
    },
  } as Message;
  return [
    user(
      1,
      'Drafts vanish when I switch accounts. Make composer drafts persist per session, across reloads and account switches.',
    ),
    agent(
      2,
      'I’ll keep each draft under its session in the device-local store and restore it when the composer mounts. Account switches only change which store is read, so drafts never cross accounts.',
    ),
    user(
      3,
      'Also keep image attachments in the draft, and open a PR when it’s green.',
    ),
    agent(
      4,
      'Done. Drafts survive a reload and an account switch, image attachments included. Each draft lives with its session in the device-local store, so nothing new is sent to the server.',
    ),
    ...(withChanges ? [diff] : []),
  ];
}

function publishToSessionStore(messages: readonly Message[]) {
  getStorage().setState((state) => ({
    sessionMessages: {
      ...state.sessionMessages,
      [SESSION_ID]: createSessionMessagesFixture({
        messagesById: Object.fromEntries(
          messages.map((message) => [message.id, message]),
        ),
        messageIdsOldestFirst: messages.map((message) => message.id),
        isLoaded: true,
      }),
    },
  }));
}

export function TranscriptTurnEndSpecimen(
  props: Readonly<{ stopped: boolean }>,
) {
  const [messages] = React.useState(() => createMessages(!props.stopped));
  const [session] = React.useState(() =>
    createSessionFixture({
      id: SESSION_ID,
      seq: 5,
      createdAt: T0,
      updatedAt: T0 + 6 * 60_000,
      // The person had read through the first reply when they came back.
      lastViewedSessionSeq: 2,
      sessionTurns: buildSessionTurnsProjectionV1({
        sessionId: SESSION_ID,
        updatedAt: T0 + 6 * 60_000,
        latestTurnId: 'turn-2',
        turns: [
          {
            turnId: 'turn-1',
            initiator: 'user',
            status: 'completed',
            startedAt: T0 + 60_000,
            updatedAt: T0 + 185_000,
            terminalAt: T0 + 185_000,
            transcriptAnchors: {
              startSeqInclusive: 1,
              endSeqInclusive: 2,
              finalAssistantMessageSeq: 2,
            },
          },
          {
            turnId: 'turn-2',
            initiator: 'user',
            status: props.stopped ? 'cancelled' : 'completed',
            startedAt: T0 + 180_000,
            updatedAt: T0 + 180_000 + (props.stopped ? 40_000 : 72_000),
            terminalAt: T0 + 180_000 + (props.stopped ? 40_000 : 72_000),
            transcriptAnchors: {
              startSeqInclusive: 3,
              endSeqInclusive: 5,
              finalAssistantMessageSeq: 4,
            },
          },
        ],
      }),
    }),
  );
  const [source] = React.useState(() =>
    createReadOnlySessionTranscriptSource({
      sessionId: SESSION_ID,
      messages,
      reducerState: null,
      metadata: session.metadata,
      agentState: null,
      historyState: { isLoaded: true, hasOlder: false, isLoadingOlder: false },
    }),
  );
  // The transcript reads the read cursor from the stored Session, as for an app Session: store it first.
  const [stored, setStored] = React.useState(false);
  React.useLayoutEffect(() => {
    publishToSessionStore(messages);
    getStorage().setState((state) => ({ sessions: { ...state.sessions, [SESSION_ID]: session } }));
    setStored(true);
    return () =>
      getStorage().setState((state) => {
        const { [SESSION_ID]: _removed, ...sessionMessages } =
          state.sessionMessages;
        const { [SESSION_ID]: _session, ...sessions } = state.sessions;
        return { sessionMessages, sessions };
      });
  }, [messages, session]);
  return (
    <View style={styles.container} testID="dev-transcript-turn-end">
      <PluginSurfaceFocusEligibilityProvider active>
        <SessionTranscriptSourceProvider source={source}>
          {stored ? <ChatList
            session={session}
            sessionSurfaceKey={JSON.stringify(['dev', SESSION_ID])}
          /> : null}
        </SessionTranscriptSourceProvider>
      </PluginSurfaceFocusEligibilityProvider>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface.base,
  },
}));
