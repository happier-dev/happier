import type { TranscriptRawAgentEventV1, WorkerUpdateV1 } from '@happier-dev/protocol';
import type { WorkerUpdateFollowMatchV1 } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { getSessionCommittedTranscriptLocalIds } from '@/api/session/client/transcript/committedTranscriptLocalIdBaseline';
import { commitRuntimeSessionEvent } from '../transcripts/publishRuntimeSessionEvent';

type WorkerEvent = Readonly<{
  localId: string;
  update: WorkerUpdateV1;
  followMatches?: readonly WorkerUpdateFollowMatchV1[];
  followInputLocalId?: string;
}>;

/** The intake owns card publication independently of native input admission. */
export function createHostWorkerUpdatePublication(params: Readonly<{
  getSession: () => ApiSessionClient;
  agentId: string;
}>) {
  let releaseSource: (() => void) | undefined;
  const commitHostEvent = async (localId: string, event: TranscriptRawAgentEventV1): Promise<void> => {
    const session = params.getSession();
    const committed = getSessionCommittedTranscriptLocalIds(session);
    if (committed.has(localId)) return;
    await commitRuntimeSessionEvent({ session, agentId: params.agentId, localId, event });
    committed.add(localId);
  };
  const commitWorkerUpdateEvents = async (events: readonly WorkerEvent[], followWakeEventLocalId?: string): Promise<void> => {
    for (const event of events) {
      await commitHostEvent(event.localId, { type: 'worker-update', update: event.update,
        ...(event.followMatches?.length ? { followMatches: [...event.followMatches] } : {}),
        ...(event.followInputLocalId ? { followInputLocalId: event.followInputLocalId } : {}),
        ...(followWakeEventLocalId ? { followWakeEventLocalId } : {}) });
    }
  };
  return {
    commitHostEvent,
    commitWorkerUpdateEvents,
    async commitContextOnlyWorkerEvents(localId: string, events: readonly WorkerEvent[], fallback: TranscriptRawAgentEventV1,
      followWakeEventLocalId?: string): Promise<void> {
      if (!events.some(event => event.localId === localId)) await commitHostEvent(localId, fallback);
      await commitWorkerUpdateEvents(events, followWakeEventLocalId);
    },
    bind(session: ApiSessionClient): void {
      releaseSource?.();
      releaseSource = session.subscribeExecutionRunWorkerUpdates?.(async event => {
        if (params.getSession() !== session) return;
        await commitWorkerUpdateEvents([event]);
      });
    },
    dispose(): void { releaseSource?.(); releaseSource = undefined; },
  };
}
