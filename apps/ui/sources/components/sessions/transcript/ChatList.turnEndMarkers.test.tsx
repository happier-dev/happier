import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  projectSessionSharedMetadataV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import type { V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import {
  buildSessionTurnsProjectionV1,
  SessionTurnsProjectionV1Schema,
} from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
  chatListHarnessState,
  resetChatListHarness,
} from '@/dev/testkit/harness/chatListHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

installTranscriptCommonModuleMocks({
  reactNative: async () =>
    (
      await import('@/dev/testkit/harness/chatListHarness')
    ).createChatListHarnessReactNativeMock({ platformOs: 'web' }),
});
installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@legendapp/list/react-native')>()),
  ...(
    await import('@/dev/testkit/harness/chatListHarness')
  ).createLegendChatListModuleMock(),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: null,
}));

await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { useHydrateSessionForRoute } =
  await import('@/hooks/session/useHydrateSessionForRoute');
const { useSessionViewShellSession } =
  await import('../shell/sessionViewStableSession');
const { ChatList } = await import('./ChatList');
const { AppSessionTranscriptSourceProvider } =
  await import('./source/appSessionTranscriptSource');

const sessionId = 'turn-end-session';
const T0 = 1_760_000_000_000;
// Two settled turns: the first finished after 1m 12s, the second was stopped after 40s. The person had read up
// to the first reply (seq 2) when they opened the Session.
const projection = SessionTurnsProjectionV1Schema.parse(
  buildSessionTurnsProjectionV1({
    sessionId,
    updatedAt: T0 + 200_000,
    latestTurnId: 'turn-b',
    turns: [
      {
        turnId: 'turn-a',
        initiator: 'user',
        status: 'completed',
        startedAt: T0,
        updatedAt: T0 + 72_000,
        terminalAt: T0 + 72_000,
        transcriptAnchors: {
          startSeqInclusive: 1,
          endSeqInclusive: 2,
          finalAssistantMessageSeq: 2,
        },
      },
      {
        turnId: 'turn-b',
        initiator: 'user',
        status: 'cancelled',
        startedAt: T0 + 100_000,
        updatedAt: T0 + 140_000,
        terminalAt: T0 + 140_000,
        transcriptAnchors: { startSeqInclusive: 3, endSeqInclusive: 4 },
      },
    ],
  }),
);

function wireSession(id: string): V2SessionRecord {
  return SessionCurrentProjectionRecordV1Schema.parse({
    id,
    seq: 4,
    createdAt: T0,
    updatedAt: T0 + 200_000,
    active: false,
    activeAt: T0 + 200_000,
    archivedAt: null,
    latestTurnId: 'turn-b',
    latestTurnStatus: 'cancelled',
    latestTurnStatusObservedAt: T0 + 140_000,
    lastViewedSessionSeq: 2,
    encryptionMode: 'plain',
    dataEncryptionKey: null,
    metadataLayoutVersion: 1,
    metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: {} })),
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(
      SessionOwnerMetadataV1Schema.parse({ v: 1 }),
    ),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    share: null,
    responsibleAccountId: null,
    responsibleAccount: null,
    effectiveAccess: {
      v: 1,
      level: 'owner',
      sources: [{ kind: 'owner' }],
      audienceContext: null,
      capabilities: projectLegacySessionAccessCapabilitiesV1({
        level: 'owner',
        canApprovePermissions: true,
      }),
    },
  });
}
function wireMessage(
  seq: number,
  value: Extract<SessionMessageV1['content'], { t: 'plain' }>['v'],
): SessionMessageV1 {
  return {
    id: `m${seq}`,
    seq,
    localId: null,
    sidechainId: null,
    content: { t: 'plain', v: value },
    createdAt: T0 + seq,
    updatedAt: T0 + seq,
  };
}
const userText = (seq: number, text: string) =>
  wireMessage(seq, { role: 'user', content: { type: 'text', text } });
const agentText = (seq: number, text: string) =>
  wireMessage(seq, {
    role: 'agent',
    content: {
      type: 'output',
      data: {
        type: 'assistant',
        uuid: `reply-${seq}`,
        parentUuid: null,
        isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    },
  });
const messages = [
  userText(1, 'Make composer drafts persist per session.'),
  agentText(
    2,
    'Drafts now live under their session in the device-local store.',
  ),
  userText(3, 'Also keep image attachments in the draft.'),
  agentText(4, 'Starting on attachments.'),
];

type Row = Readonly<{
  kind: string;
  id: string;
  marker?: Readonly<{ type: string; outcome?: string; durationMs?: number }>;
}>;
function rowShape(data: readonly Row[] | undefined): string[] {
  return (data ?? []).map((row) =>
    row.kind === 'transcript-marker' ? `marker:${row.id}` : row.id,
  );
}

afterEach(standardCleanup);

describe('Session open → settled turns and read cursor → transcript markers', () => {
  it.each([true, false])(
    'places New at the opened read cursor and each settled turn line (show duration: %s)',
    async (showTurnDuration) => {
      resetChatListHarness({ platformOs: 'web' });
      const locks = installWebLockManagerMock();
      let connection:
        | Awaited<ReturnType<typeof restoreServerAccountForTest>>
        | undefined;
      onTestFinished(async () => {
        standardCleanup();
        await connection?.dispose();
        storage.setState(storage.getInitialState(), true);
        locks.restore();
      });
      const http = createHomeHubArtifactHttpBoundary('reader');
      connection = await restoreServerAccountForTest({
        serverUrl: 'https://turn-end.test',
        accountId: 'reader',
        request: createSessionReadBatchFetchBoundary(async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === '/v2/session-organization')
            return Response.json(
              SessionOrganizationSnapshotResponseSchema.parse({
                snapshot: {
                  schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
                  version: 0,
                  pins: [],
                  folders: [],
                  folderAssignments: [],
                  tags: [],
                  tagAssignments: [],
                  orderEntries: [],
                  labels: [],
                },
              }),
            );
          if (path === '/v2/sessions' || path === '/v2/sessions/active')
            return Response.json({
              sessions: [wireSession(sessionId)],
              hasNext: false,
              nextCursor: null,
            });
          if (path === `/v2/sessions/${sessionId}`)
            return Response.json({ session: wireSession(sessionId) });
          if (path === '/v2/sessions/metadata-upgrades')
            return Response.json({ sessionIds: [] });
          if (path === `/v1/sessions/${sessionId}/turns`)
            return Response.json(projection);
          if (path === `/v1/sessions/${sessionId}/messages`)
            return Response.json({
              messages,
              hasMore: false,
              nextBeforeSeq: null,
              nextAfterSeq: null,
            });
          return http.request(input, init);
        }),
      });
      await sync.refreshSessions({ awaitSessionListHydration: true });
      const serverId = connection.home.id;
      function OpenTranscript() {
        useHydrateSessionForRoute(sessionId, 'UI-TRANSCRIPT.open', {
          serverId,
        });
        const session = useSessionViewShellSession(sessionId, serverId);
        return session ? (
          <AppSessionTranscriptSourceProvider
            sessionId={sessionId}
            serverId={serverId}
          >
            <ChatList
              session={session}
              sessionSurfaceKey={sessionAddressKey({ sessionId, serverId })}
            />
          </AppSessionTranscriptSourceProvider>
        ) : null;
      }
      const screen = await renderScreen(<OpenTranscript />);
      await flushHookEffects({ cycles: 40 });
      await act(async () => {
        await sync.refreshSessionMessages(sessionId);
      });
      await sync.ensureSessionVisibleForMessageRoute(sessionId, {
        serverId,
        includeTurnsProjection: true,
      });
      // The person's Account preference, written after Account settings have synced.
      await act(async () => {
        storage.getState().applySettingsLocal({ transcriptShowTurnDuration: showTurnDuration });
      });
      await flushHookEffects({ cycles: 40 });
      expect(storage.getState().sessions[sessionId]?.sessionTurns).toEqual(
        projection,
      );

      const rows = rowShape(
        chatListHarnessState.legendListProps?.data as
          | readonly Row[]
          | undefined,
      );
      const messageRows = rows.filter((row) => !row.startsWith('marker:'));
      expect(messageRows).toHaveLength(4);
      // Message rows keep transcript order; seq N is the Nth message row.
      const at = (seq: number) => rows.indexOf(messageRows[seq - 1]!);
      const newIndex = rows.indexOf('marker:transcript-marker:new');
      // New sits between what was read (through seq 2) and the first row after the cursor.
      expect(newIndex, rows.join(',')).toBeGreaterThan(at(2));
      expect(newIndex).toBeLessThan(at(3));
      const turnA = rows.indexOf('marker:transcript-marker:turn-end:turn-a');
      const turnB = rows.indexOf('marker:transcript-marker:turn-end:turn-b');
      if (showTurnDuration) {
        // Each line closes its own turn, ahead of the next turn's divider and prompt.
        expect(turnA).toBeGreaterThan(at(2));
        expect(turnA).toBeLessThan(newIndex);
        expect(turnB).toBeGreaterThan(at(4));
        // Each line's length comes from the turn's recorded start and end; a stopped turn says so.
        const markers = (chatListHarnessState.legendListProps?.data as readonly Row[] | undefined ?? [])
          .filter((row) => row.marker?.type === 'turn-end')
          .map((row) => row.marker);
        expect(markers).toEqual([
          { type: 'turn-end', outcome: 'worked', durationMs: 72_000 },
          { type: 'turn-end', outcome: 'stopped', durationMs: 40_000 },
        ]);
        const lines = screen
          .findAllHostsByTestId('transcript-turn-duration')
          .map((node) => [node.props.children].flat().join(''));
        expect(lines).toEqual(['session.transcriptTurnEnd.workedFor', 'session.transcriptTurnEnd.stoppedAfter']);
      } else {
        expect([turnA, turnB]).toEqual([-1, -1]);
        expect(screen.findAllHostsByTestId('transcript-turn-duration')).toEqual(
          [],
        );
      }
      expect(screen.findHostByTestId('transcript-new-divider')).not.toBeNull();
    },
  );
});
