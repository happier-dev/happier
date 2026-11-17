import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { Message } from '@happier-dev/session-core/messages';
import {
  normalizeRawMessage,
  type NormalizedMessage,
} from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import type { FollowSourceRelationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { projectSessionMessageInvocationV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1';

import {
  projectSessionFollowerCensus,
  SessionPeopleFollowSheet,
  type SessionPeopleFollow,
} from '@/components/sessions/collaboration/SessionPeopleFollowSections';
import { SessionAskRecordContent } from '@/components/sessions/transcript/askRecord/SessionAskRecord';
import { readSessionMessageInvocation } from '@/components/sessions/transcript/references/readSessionMessageInvocation';
import { projectSessionMessageInvocationRead } from '@/components/sessions/transcript/references/useSessionMessageInvocation';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { applySessionReturnedAnswerChanges } from '@/sync/store/sessionReturnedAnswers';
import { useIsTablet } from '@/utils/platform/responsive';

/**
 * Dev-only specimen of two coordination states a QA stack rarely holds at once (coordination lab V3), drawn by
 * their real owners from fixture facts:
 * - `?scene=followers` — People's Followers sheet over a populated reverse census (lab P1-P, P2-S): your level,
 *   several follower Sessions (an ordinary follower at two levels and a manager-only receiver) and other people.
 *   The census carries no rule or Bot facts, so none are drawn.
 * - `?scene=ask` — a composer Ask to Siblings with one line per frozen target (lab T1-Q, P6-A, P6-C): answered
 *   with its returned snippet, passed and not sent; and an Ask to Workers whose delivery is unsure.
 * Session names come from session-list rows seeded under a specimen-only Home. No RPC, store write or send
 * beyond that seed, which is removed on unmount.
 */
export type CoordinationStatesScene = 'followers' | 'ask';

const HOME = 'coordination-specimen';
const THIS = 'idempotent-retries';
const TITLES: Readonly<
  Record<string, Readonly<{ name: string; flavor: string }>>
> = {
  [THIS]: { name: 'Idempotent retries in payments-api', flavor: 'codex' },
  coordinator: { name: 'Daily coordinator', flavor: 'claude' },
  rollout: { name: 'Payments v2 rollout', flavor: 'claude' },
  runbook: { name: 'Support runbook for retries', flavor: 'gemini' },
  checkout: { name: 'Checkout UI retry states', flavor: 'claude' },
  ledger: { name: 'Backfill intent ledger', flavor: 'codex' },
  review: { name: 'Review each changed file', flavor: 'codex' },
};

function useSeededSessionRows() {
  React.useEffect(() => {
    const before = storage.getState().sessionListRowsByServerId[HOME];
    const rows = Object.fromEntries(
      Object.entries(TITLES).map(([id, { name, flavor }]) => [
        id,
        createSessionListRenderableSessionFixture({
          id,
          metadata: { name, path: '/src/payments-api', flavor },
        }),
      ]),
    );
    storage.setState((current) => ({
      sessionListRowsByServerId: {
        ...current.sessionListRowsByServerId,
        [HOME]: rows,
      },
    }));
    return () =>
      storage.setState((current) => {
        const next = { ...current.sessionListRowsByServerId };
        if (before) next[HOME] = before;
        else delete next[HOME];
        return { sessionListRowsByServerId: next };
      });
  }, []);
}

/* Followers ------------------------------------------------------------------------------------------- */

function follower(
  destinationSessionId: string,
  preset: 'everything' | 'important' | 'quiet',
  relation: 'follower' | 'manager',
): FollowSourceRelationV1 {
  return {
    sourceSessionId: THIS,
    destinationSessionId,
    relation,
    policy: { preset },
    deliveryState: 'eligible',
    hasPendingUpdates: false,
  };
}

const noop = () => {};
const PEOPLE: SessionPeopleFollow = {
  enabled: true,
  // You follow it (one of the four people), so the sheet counts three others.
  census: projectSessionFollowerCensus({
    sources: [
      follower('coordinator', 'important', 'follower'),
      follower('runbook', 'quiet', 'follower'),
      follower('rollout', 'important', 'manager'),
    ],
    follows: [{ viewer: true }],
    peopleCount: 4,
  }),
  followersLoading: false,
  followersError: null,
  refreshFollowers: noop,
  following: {
    projection: null,
    loading: false,
    error: null,
    refresh: async () => {},
    ruleInputs: {
      snapshot: null,
      lifetime: null,
      accountId: undefined,
      refresh: async () => null,
      loading: false,
    },
  },
  youLevel: 'important',
  youLoading: false,
};

function FollowersScene() {
  const anchored = useIsTablet();
  const anchorRef = React.useRef<View>(null);
  const focusReturnRef = React.useRef(null);
  const target = { serverId: HOME, sessionId: THIS };
  if (!anchored) {
    return (
      <SessionPeopleFollowSheet
        target={target}
        machineId={null}
        direction="followers"
        people={PEOPLE}
        host={{ kind: 'page', onClose: noop }}
      />
    );
  }
  return (
    <View style={styles.anchorColumn}>
      <View ref={anchorRef} collapsable={false} style={styles.anchor} />
      <SessionPeopleFollowSheet
        target={target}
        machineId={null}
        direction="followers"
        people={PEOPLE}
        host={{ kind: 'panel', anchorRef, focusReturnRef, onClose: noop }}
      />
    </View>
  );
}

/* Ask record ------------------------------------------------------------------------------------------ */

const accepted = (localId: string) =>
  ({
    ok: true,
    result: { status: 'accepted', localId },
  }) as const satisfies ActionExecuteResult;
const refused = {
  ok: false,
  errorCode: 'permission_denied',
  error: 'Unavailable',
} as const satisfies ActionExecuteResult;
const unsure = {
  ok: false,
  errorCode: 'outcome_unknown',
  error: 'The send was not confirmed',
} as const satisfies ActionExecuteResult;

/** The composer's one non-executing source entry, through the real invocation projector and transcript reducer. */
function composerEntry(
  localId: string,
  target: SessionTargetV1,
  text: string,
  results: ReadonlyArray<readonly [string, ActionExecuteResult]>,
): NormalizedMessage {
  const invocation = projectSessionMessageInvocationV1({
    serverId: HOME,
    localId,
    requestLocalId: localId,
    target,
    reply: 'return',
    result: {
      ok: true,
      result: {
        kind: 'fanout',
        results: results.map(([sessionId, result]) => ({
          target: { serverId: HOME, sessionId },
          result,
        })),
      },
    },
  });
  const raw = normalizeRawMessage(
    `entry-${localId}`,
    localId,
    10,
    {
      role: 'agent',
      content: {
        type: 'event',
        id: localId,
        data: {
          type: 'message',
          message: text,
          sessionMessageInvocationV1: invocation,
        },
      },
    },
    { messageRole: 'event', seq: 1 },
  );
  if (!raw) throw new Error('Ask source entry must normalize');
  return raw;
}

/** A return admitted into the asker's transcript, as the target's answer or pass arrives. */
function returned(
  id: string,
  requestSessionId: string,
  requestLocalId: string,
  outcome: 'answer' | 'pass',
  text: string,
): NormalizedMessage {
  return {
    id,
    localId: id,
    createdAt: 20,
    role: 'user',
    isSidechain: false,
    content: { type: 'text', text },
    meta: {
      happierInputAuthorityV1: {
        v: 1,
        producer: 'sessionAction',
        permission: { admittedPermissionCeiling: 'read-only' },
        caller: { kind: 'host' },
        returnedAnswer: {
          requestSessionId,
          requestLocalId,
          outcome,
          delivery: 'wake',
          senderSessionId: requestSessionId,
        },
      },
    },
  };
}

const ASK_TRANSCRIPT = reducer(createReducer(), [
  composerEntry(
    'ask-siblings',
    { selector: 'siblings' },
    'Does a replayed charge show a different banner, and does the runbook mention it?',
    [
      ['checkout', accepted('ask-siblings')],
      ['runbook', accepted('ask-siblings')],
      ['review', refused],
    ],
  ),
  returned(
    'return-checkout',
    'checkout',
    'ask-siblings',
    'answer',
    'No banner change; replays read as confirmed',
  ),
  returned(
    'return-runbook',
    'runbook',
    'ask-siblings',
    'pass',
    'The requested session passed without an answer.',
  ),
  composerEntry(
    'ask-workers',
    { selector: 'workers' },
    'Is the ledger backfill safe to run against the replica?',
    [
      ['ledger', accepted('ask-workers')],
      ['review', unsure],
    ],
  ),
  returned(
    'return-ledger',
    'ledger',
    'ask-workers',
    'answer',
    'Yes, it reads the replica only and writes in batches',
  ),
]).messages;
const RETURNED = Object.values(
  applySessionReturnedAnswerChanges({
    previous: undefined,
    messages: Object.fromEntries(
      ASK_TRANSCRIPT.map((message) => [message.id, message]),
    ),
    changes: [],
  }),
).flat();
const ASKS = ASK_TRANSCRIPT.filter(
  (message): message is Message =>
    readSessionMessageInvocation(message, {
      serverId: HOME,
      sessionId: THIS,
    }) !== null,
);

function AskScene() {
  const source = React.useMemo(
    () =>
      createReadOnlySessionTranscriptSource({
        sessionId: THIS,
        serverId: HOME,
        messages: ASK_TRANSCRIPT,
        reducerState: null,
        metadata: null,
        agentState: null,
      }),
    [],
  );
  return (
    <SessionTranscriptSourceProvider source={source}>
      <View style={styles.transcript}>
        {ASKS.map((message) => {
          const record = projectSessionMessageInvocationRead({
            entry: readSessionMessageInvocation(message, {
              serverId: HOME,
              sessionId: THIS,
            }),
            homeServerId: HOME,
            sourceRowId: message.id,
            replies: null,
            returnedAnswers: RETURNED.map((entry) => entry.answer),
            refreshing: false,
            refresh: noop,
          });
          return record.status === 'ready' ? (
            <SessionAskRecordContent
              key={message.id}
              message={message}
              sessionId={THIS}
              serverId={HOME}
              record={record}
              returned={RETURNED}
            />
          ) : null;
        })}
      </View>
    </SessionTranscriptSourceProvider>
  );
}

export function CoordinationStatesSpecimen(
  props: Readonly<{ scene: CoordinationStatesScene }>,
) {
  useSeededSessionRows();
  if (props.scene === 'followers') return <FollowersScene />;
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <AskScene />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.base },
  content: { paddingVertical: theme.space.s24, alignItems: 'center' },
  transcript: { width: '100%' },
  anchorColumn: { flex: 1, alignItems: 'flex-end', padding: theme.space.s24 },
  anchor: { width: 360, height: theme.space.s40 },
}));
