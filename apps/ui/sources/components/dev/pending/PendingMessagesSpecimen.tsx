import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PendingMessagesTranscriptBlock } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { buildTrustedHostSessionInputAdmissionV1, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import {
  storage,
  useActiveServerAccountScope,
} from '@/sync/domains/state/storage';
import type {
  DiscardedPendingMessage,
  PendingMessage,
  Session,
} from '@/sync/domains/state/storageTypes';

/**
 * `queued`: two waiting messages. `held`: queued behind a withdrawn Machine grant. `stopped`: a person stopped
 * the Session and its message waits (menu: the way forward, then Remove). `notSent`: a message the Session refused
 * (a reset Team model connection). `approvalResult`: a decided approval's failed result waiting to reach the Agent.
 */
export const PENDING_MESSAGES_SCENES = ['queued', 'held', 'stopped', 'notSent', 'approvalResult'] as const;
export type PendingMessagesScene = (typeof PENDING_MESSAGES_SCENES)[number];

const SESSION_ID = 'dev-pending-messages';
const NO_DISCARDED = Object.freeze([]);

function queuedMessage(
  id: string,
  text: string,
  createdAt: number,
): PendingMessage {
  return {
    id,
    localId: id,
    text,
    createdAt,
    updatedAt: createdAt,
    source: 'server_pending',
    pendingDeliveryStatus: 'server_queued',
    rawRecord: {},
  } as PendingMessage;
}

const MESSAGES: readonly PendingMessage[] = [
  queuedMessage(
    'dev-pending-1',
    'Once the migration finishes, run the integration suite and tell me which tests still fail.',
    1,
  ),
  queuedMessage(
    'dev-pending-2',
    'Then draft the release notes for the billing fix.',
    2,
  ),
];

const NOT_SENT: readonly DiscardedPendingMessage[] = [{
  ...queuedMessage('dev-not-sent-1', 'Please make the checkout heading more concise.', 3),
  discardedAt: 4,
  discardedReason: 'team_credential_binding_not_current',
} as DiscardedPendingMessage];

const APPROVAL_RESULT: readonly PendingMessage[] = [{
  ...queuedMessage('dev-approval-result', JSON.stringify({ actionId: 'machines.list', status: 'executed',
    execution: { executedAtMs: 5, ok: false, errorCode: 'machine_unavailable' } }), 5),
  localId: 'approval-result:dev-approval',
  rawRecord: { meta: { [SESSION_MESSAGE_PROVENANCE_META_KEY]: buildTrustedHostSessionInputAdmissionV1('mcp').provenance } },
} as PendingMessage];

const STOPPED: readonly PendingMessage[] = MESSAGES.slice(0, 1);

function sceneMessages(scene: PendingMessagesScene): readonly PendingMessage[] {
  if (scene === 'notSent') return [];
  if (scene === 'stopped') return STOPPED;
  if (scene === 'approvalResult') return APPROVAL_RESULT;
  return MESSAGES;
}

/**
 * The stopped Session this queue belongs to, client-local and removed on unmount. `held` carries the
 * withdrawal the access owner publishes when a person's Machine access is withdrawn.
 */
function useSeededSession(
  serverId: string | null,
  scene: PendingMessagesScene,
): boolean {
  const [seeded, setSeeded] = React.useState(false);
  React.useEffect(() => {
    if (!serverId) return;
    const metadata = {
      path: '/Users/dev/harbor-ledger',
      host: 'studio-runner',
      homeDir: '/Users/dev',
      machineId: 'dev-pending-machine',
      ...(scene === 'held'
        ? { lifecycleStateReason: 'machine_access_withdrawn' }
        : {}),
    };
    const session = createSessionFixture({
      id: SESSION_ID,
      serverId,
      active: false,
      metadata: (scene === 'stopped'
        ? writeSessionExplicitStopV1ToMetadata(metadata, { v: 1, cause: 'explicit_stop', requestId: 'dev-stop', requestedAtMs: 1 })
        : metadata) as Session['metadata'],
    });
    const state = storage.getState();
    // Never replace an existing local entry, even in a dev specimen.
    if (state.sessions[SESSION_ID]) return;
    storage.setState({
      sessions: { ...state.sessions, [SESSION_ID]: session },
    });
    setSeeded(true);
    return () => {
      setSeeded(false);
      storage.setState((current) => {
        if (current.sessions[SESSION_ID] !== session) return current;
        const sessions = { ...current.sessions };
        delete sessions[SESSION_ID];
        return { sessions };
      });
    };
  }, [serverId, scene]);
  return seeded;
}

/** Dev-only: a Session's queued messages drawn by the real Pending block (`PENDING_MESSAGES_SCENES`). */
export function PendingMessagesSpecimen(
  props: Readonly<{ scene: PendingMessagesScene }>,
) {
  const scope = useActiveServerAccountScope();
  const seeded = useSeededSession(scope?.serverId ?? null, props.scene);
  if (!scope || !seeded) return null;
  return (
    <View style={styles.page} testID="dev-pending-messages">
      <View style={styles.column}>
        <PendingMessagesTranscriptBlock
          sessionId={SESSION_ID}
          serverId={scope.serverId}
          pendingMessages={sceneMessages(props.scene)}
          discardedMessages={props.scene === 'notSent' ? NOT_SENT : NO_DISCARDED}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: theme.colors.background.canvas,
    padding: theme.space.s16,
  },
  column: {
    width: '100%',
    maxWidth: PAGE_LIST_METRICS.columnMaxWidthPx.reading,
    alignSelf: 'center',
  },
}));
