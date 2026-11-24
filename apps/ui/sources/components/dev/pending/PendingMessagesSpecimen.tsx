import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PendingMessagesTranscriptBlock } from '@/components/sessions/pending/PendingMessagesTranscriptBlock';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import {
  storage,
  useActiveServerAccountScope,
} from '@/sync/domains/state/storage';
import type {
  PendingMessage,
  Session,
} from '@/sync/domains/state/storageTypes';

export const PENDING_MESSAGES_SCENES = ['queued', 'held'] as const;
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
    const session = createSessionFixture({
      id: SESSION_ID,
      serverId,
      active: false,
      metadata: {
        path: '/Users/dev/harbor-ledger',
        host: 'studio-runner',
        homeDir: '/Users/dev',
        machineId: 'dev-pending-machine',
        ...(scene === 'held'
          ? { lifecycleStateReason: 'machine_access_withdrawn' }
          : {}),
      } as Session['metadata'],
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

/** Dev-only: a Session's queued messages drawn by the real Pending block. `scene=queued|held`. */
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
          pendingMessages={MESSAGES}
          discardedMessages={NO_DISCARDED}
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
