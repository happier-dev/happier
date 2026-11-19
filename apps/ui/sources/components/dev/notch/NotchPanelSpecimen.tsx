import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { ScopedTheme, StyleSheet, useUnistyles } from 'react-native-unistyles';

import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import type { DesktopActivityOverlaySnapshot } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlaySnapshot';
import { DesktopActivityOverlayExpandedCards } from '@/activity/adapters/desktop/ui/cards/DesktopActivityOverlayExpandedCards';
import { DesktopActivityOverlaySessionRow } from '@/activity/adapters/desktop/ui/DesktopActivityOverlaySessionRow';
import { resolveNotchMetrics } from '@/activity/adapters/desktop/ui/notch/notchShapeGeometry';
import { useNotchPlanePaint } from '@/activity/adapters/desktop/ui/notch/NotchShape';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { resolveSessionPermissionChoices } from '@/sync/ops/sessionPermissionChoices';
import { Text } from '@/components/ui/text/Text';
import { DesktopActivityOverlayExpanded } from '@/activity/adapters/desktop/ui/DesktopActivityOverlayExpanded';
import { DesktopActivityOverlayConversation } from '@/activity/adapters/desktop/ui/conversation/DesktopActivityOverlayConversation';

/**
 * Dev-only: the desktop notch's open panel on its plane, built through the real model owner
 * (`buildDesktopActivityOverlayModel`) and drawn by the real cards and rows. `?only=list|ask|idle|bot`.
 */
const SERVER_ID = 'specimen-home';

type SessionSnapshot = DesktopActivityOverlaySnapshot['sessions'][number];

function session(
  sessionId: string,
  title: string,
  statusText: string,
  tone: SessionSnapshot['tone'],
  agentId: string,
  subtitle: string | null,
): SessionSnapshot {
  return {
    serverId: SERVER_ID,
    sessionId,
    title,
    subtitle,
    statusText,
    previewText: null,
    attentionState: tone === 'attention' ? 'action_required' : 'failed',
    active: true,
    updatedAt: 1,
    tone,
    agentId,
    machineId: null,
  };
}

const SESSIONS: readonly SessionSnapshot[] = [
  session(
    's-tests',
    'Flaky checkout tests',
    'Error',
    'danger',
    'codex',
    'happier/web',
  ),
  session(
    's-deploy',
    'Preview deploy for billing',
    'Error',
    'danger',
    'claude',
    'happier/server',
  ),
  session(
    's-search',
    'Index rebuild',
    'Error',
    'danger',
    'muse',
    'search-infra',
  ),
  session(
    's-auth',
    'Token refresh race',
    'Action required',
    'attention',
    'claude',
    'happier/server',
  ),
  session(
    's-docs',
    'Release notes draft',
    'Action required',
    'attention',
    'muse',
    'happier/docs',
  ),
];

const MUSE_CHOICES = resolveSessionPermissionChoices({
  toolName: 'Bash',
  nativeChoices: {
    requirementId: 'specimen-muse',
    source: 'muse',
    choices: [
      {
        id: 'muse:allow_once',
        label: 'Allow once',
        decision: 'approved',
        scope: 'once',
        response: { approved: true, decision: 'approved' },
      },
      {
        id: 'muse:reject',
        label: 'Reject',
        decision: 'denied',
        scope: 'once',
        response: { approved: false, decision: 'denied' },
      },
    ],
  },
});

function snapshot(
  params: Readonly<{
    ask: boolean;
    state?: DesktopActivityOverlaySnapshot['state'];
  }>,
): DesktopActivityOverlaySnapshot {
  return {
    version: 1,
    generatedAt: 1,
    state: params.state ?? 'content',
    counts: {
      unread: 0,
      permissionRequired: 1,
      actionRequired: 2,
      thinking: 0,
      totalAttention: 3,
    },
    summaryCounts: { attentionCount: 3, runningCount: 0, permissionCount: 1 },
    primary: null,
    sessions:
      params.state === 'idle'
        ? []
        : [
            ...SESSIONS,
            session(
              's-ask',
              'Nightly import',
              'Permission required',
              'attention',
              'muse',
              'data-pipeline · build-box',
            ),
          ],
    bots: { faces: [], overflowCount: 0 },
    conversation: null,
    permissionRequests: params.ask
      ? [
          {
            activityInstanceId: 'specimen-ask',
            kind: 'permission_request',
            requestId: 'specimen-ask',
            serverId: SERVER_ID,
            sessionId: 's-ask',
            title: 'Run a command',
            summary: 'pnpm --filter importer run nightly --since 2026-11-18',
            toolLabel: 'Bash',
            questionText: null,
            count: 1,
            subject: {
              kind: 'command',
              text: 'pnpm --filter importer run nightly --since 2026-11-18', additions: null, deletions: null,
            },
            openActionIdentifier: 'open-session:s-ask',
            allowActionIdentifier: 'session.permission.respond',
            denyActionIdentifier: 'session.permission.respond',
            directOptions: [],
            permissionChoices: MUSE_CHOICES,
          },
        ]
      : [],
    userQuestions: [],
    quotaSummaries: [],
    completionStates: [],
    defaultTarget: 'open-inbox',
    labels: { sessionsTitle: 'Sessions', emptyTitle: 'No active sessions' },
  } as DesktopActivityOverlaySnapshot;
}

const entry = (sessionId: string) => ({
  id: sessionAddressKey({ serverId: SERVER_ID, sessionId }),
  dismissKey: sessionId,
  address: { serverId: SERVER_ID, sessionId },
  sessionId,
  activity: 'needsYou' as const,
  title: sessionId,
  subtitle: null,
  contextLine: null,
  accessibilityContext: null,
});
const SHARED = {
  visible: true,
  activity: 'needsYou' as const,
  word: 'Needs you',
  entries: [entry('s-ask'), entry('s-auth'), entry('s-docs')],
  tray: [],
};
const POLICY = { enabled: true } as Parameters<
  typeof buildDesktopActivityOverlayModel
>[0]['policy'];

export function NotchPanelSpecimen(props: Readonly<{ only: string | null }>) {
  const show = (id: string) => props.only === null || props.only === id;
  const list = React.useMemo(
    () =>
      buildDesktopActivityOverlayModel({
        snapshot: snapshot({ ask: true }),
        policy: POLICY,
        sharedActivity: SHARED,
      }),
    [],
  );
  const idle = React.useMemo(
    () =>
      buildDesktopActivityOverlayModel({
        snapshot: snapshot({ ask: false, state: 'idle' }),
        policy: POLICY,
        sharedActivity: SHARED,
      }),
    [],
  );
  const asks = React.useMemo(
    () => ({
      expanded: {
        title: '',
        rows: [],
        cards:
          list.expanded.cards?.filter(
            (card) => card.kind === 'permission_request',
          ) ?? [],
      },
    }),
    [list],
  );
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {show('list') ? (
        <Panel title="Open list: an ask, then the Sessions that need you, then the rest">
          <DesktopActivityOverlayExpandedCards
            model={list}
            visualMode="notch_integrated"
            onOpenSession={() => {}}
            onAction={() => {}}
          />
        </Panel>
      ) : null}
      {show('ask') ? (
        <Panel title="Pinned conversation's ask: the header names the asker, so the ask stands alone">
          <DesktopActivityOverlayExpandedCards
            model={asks}
            askerShown
            visualMode="notch_integrated"
            onOpenSession={() => {}}
            onAction={() => {}}
          />
        </Panel>
      ) : null}
      {show('bot') ? (
        <Panel title="A row with meta: the age ends the name's line">
          <DesktopActivityOverlaySessionRow
            visualMode="notch_integrated"
            title="Nightly import"
            subtitle={null}
            statusText="Needs you"
            previewText="Waiting to run the import"
            tone="attention"
            agentId="muse"
            meta="3m ago"
            onPress={() => {}}
          />
          <DesktopActivityOverlaySessionRow
            visualMode="notch_integrated"
            title="Release notes draft"
            subtitle={null}
            statusText="Working"
            previewText="Summarising 14 merged changes"
            agentId="claude"
            meta="12m ago"
            onPress={() => {}}
          />
        </Panel>
      ) : null}
      {show('conversation') ? <ConversationSpecimen room={640} /> : null}
      {show('conversation') ? <ConversationSpecimen room={360} /> : null}
      {show('sending') ? <ConversationSpecimen room={360} sending /> : null}
      {show('idle') ? (
        <Panel title="Nothing selected">
          <DesktopActivityOverlayExpandedCards
            model={idle}
            visualMode="notch_integrated"
            onOpenSession={() => {}}
          />
        </Panel>
      ) : null}
    </ScrollView>
  );
}

const TURNS = [
  'Can you trace why the nightly import stalls after the first batch?',
  'The importer holds one connection per shard and never releases it when a batch ends early, so the pool runs dry around batch 40 and every later batch waits on its acquire timeout.',
  'Release it in the finally block and add a test for the early end.',
  'Done. The connection now returns to the pool in a finally block, and importer.test.ts covers a batch that ends early. All 214 tests pass.',
  'Run it once against staging with --since 2026-11-18.',
  'Running it now. Batches 1 to 62 completed in 3m 40s with no waits on the pool; the import finished cleanly.',
  'Great. Open a PR with a short summary.',
  'Opened #482: "Release importer connections when a batch ends early", with the test and the staging run in the description.',
].map((text, index) => ({ id: `t${index}`, role: index % 2 === 0 ? 'user' as const : 'agent' as const, text }));

/** The pinned conversation at a tall island's room: it grows with its turns and scrolls only past it. */
function ConversationSpecimen(props: Readonly<{ room: number; sending?: boolean }>) {
  const [natural, setNatural] = React.useState(0);
  const conversation = React.useMemo(() => ({ serverId: SERVER_ID, sessionId: 's-ask', accountId: 'specimen',
    reply: { state: 'ready' as const, messages: TURNS }, refreshing: false, reachable: true }), []);
  const row = React.useMemo(() => buildDesktopActivityOverlayModel({ snapshot: snapshot({ ask: false }), policy: POLICY, sharedActivity: SHARED })
    .expanded.rows.find((candidate) => candidate.sessionId === 's-ask') ?? null, []);
  return (
    <Panel title={`Pinned conversation in a ${props.room} pt island: asks the planner for ${Math.round(natural)} pt`} bare>
      <DesktopActivityOverlayExpanded visualMode="notch_integrated" maxHeight={props.room} onNaturalHeight={setNatural}
        onOpenSession={() => {}} model={{ expanded: { title: '', rows: [], cards: [] } }}
        content={<DesktopActivityOverlayConversation conversation={conversation} face={null} row={row} cards={[]}
          phrases={['Continue', 'OK']} draft={props.sending ? 'Ship it once CI is green' : ''} draftWriteError={null} onRetryDraft={() => {}}
          onDraftChange={() => {}} onSend={props.sending ? () => new Promise<boolean>(() => {}) : async () => true} onBack={() => {}} onUnpin={() => {}}
          onExtract={async () => true} onAction={() => {}} onDismissKey={() => {}} />} />
    </Panel>
  );
}

function Panel(props: React.PropsWithChildren<Readonly<{ title: string; bare?: boolean }>>) {
  return (
    <View style={styles.section}>
      <Text variant="meta" style={styles.note}>
        {props.title}
      </Text>
      {/* The island is one dark material in every app theme, as the overlay route scopes it. */}
      <ScopedTheme name="dark">
        <Plane bare={props.bare}>{props.children}</Plane>
      </ScopedTheme>
    </View>
  );
}

function Plane(props: React.PropsWithChildren<Readonly<{ bare?: boolean }>>) {
  const { theme } = useUnistyles();
  const plane = useNotchPlanePaint();
  return (
    <View style={[props.bare ? styles.planeBare : styles.plane, { backgroundColor: plane, width: resolveNotchMetrics(theme).openWidth }]}>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    padding: theme.space.s24,
    gap: theme.space.s32,
    backgroundColor: theme.colors.surface.canvas,
  },
  section: { gap: theme.space.s8 },
  note: { color: theme.colors.text.secondary },
  planeBare: { borderRadius: theme.borderRadius.lg, overflow: 'hidden' },
  plane: { padding: theme.space.s12, borderRadius: theme.borderRadius.lg },
}));
