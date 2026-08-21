import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import { mergeSessionWorkStateMetadataV1 } from '@/session/workState/sessionWorkStateMetadata';
import { createWorkflowActivityPublisher } from '@/session/systemRecords/activity/publishWorkflowActivitySnapshot';
import { createSessionWorkflowActivityTransport } from '@/session/systemRecords/activity/sessionWorkflowActivityTransport';
import { logger } from '@/ui/logger';

import { createGrokSessionNotificationObserver } from './sessionNotifications';

const GROK_GOAL_WORK_STATE_SOURCE_FAMILY = 'grok.goal';

export function createGrokSessionNotificationObserverForSession(
  session: ApiSessionClient,
): ReturnType<typeof createGrokSessionNotificationObserver> {
  const transport = createSessionWorkflowActivityTransport({
    sessionId: session.sessionId,
    metadataWriter: session,
    upsertSystemRecord: session.upsertSessionSystemRecord.bind(session),
    fetchSystemRecord: session.fetchSessionSystemRecord.bind(session),
    resolveEncryption: async () => session.getStoredContentEncryptionContext(),
  });
  const snapshots = new Map<string, SessionWorkflowRunSnapshotV1>();
  const publisher = createWorkflowActivityPublisher({
    backendId: 'grok',
    agentId: 'grok',
    commitRecord: transport.commitRecord,
    ...(transport.readCommittedRunSnapshot
      ? { readCommittedRunSnapshot: transport.readCommittedRunSnapshot }
      : {}),
    writeHeadlines: transport.writeHeadlines,
    onError: (error, detail) => {
      logger.warn(
        `[GrokACP] Workflow activity record publication failed for ${detail.runId} (${detail.retryable ? 'retryable' : 'permanent'})`,
        error,
      );
    },
  });

  return createGrokSessionNotificationObserver({
    async publishWorkflowSnapshot(snapshot) {
      snapshots.set(snapshot.runId, snapshot);
      try {
        const result = await publisher.publish({
          snapshots,
          changedRunIds: [snapshot.runId],
        });
        return !result.failedRunIds.includes(snapshot.runId)
          && !result.permanentFailedRunIds.includes(snapshot.runId);
      } catch (error) {
        logger.warn('[GrokACP] Workflow activity headline publication failed', error);
        return false;
      }
    },
    async publishGoalWorkState(snapshot) {
      try {
        await session.updateMetadata((metadata) => {
          const merged = mergeSessionWorkStateMetadataV1({
            metadata,
            nextOwned: snapshot,
            ownedSourceFamilies: [GROK_GOAL_WORK_STATE_SOURCE_FAMILY],
          });
          return {
            ...metadata,
            sessionWorkStateV1: merged.sessionWorkStateV1,
          } as Metadata;
        });
      } catch (error) {
        logger.warn('[GrokACP] Goal work-state publication failed', error);
      }
    },
  });
}
