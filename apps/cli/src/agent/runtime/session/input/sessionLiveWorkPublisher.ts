import { logger } from '@/ui/logger';
import { notifyDaemonSessionActivityChanged } from '@/daemon/controlClient';
import type { DaemonControlRequestOptions } from '@/daemon/controlHttp';
import type { SessionProviderInputConsumer } from './_types';

/**
 * Pushes this runner's live work to the daemon after every change, so the daemon applies it
 * without reading the runner back. Revisions order the pushes of this process; a read that
 * fails falls back to a content-free push, which makes the daemon read.
 */
export function publishSessionLiveWorkToDaemon(params: Readonly<{
  consumer: Pick<SessionProviderInputConsumer<unknown, unknown>, 'subscribeLiveWork' | 'readLiveWork'>;
  readSessionId: () => string;
  /** The daemon tracks this runner by its process id. */
  runnerPid?: number;
  onUnavailable: () => void;
  /** The daemon control transport; defaults to the persisted daemon state. */
  daemon?: DaemonControlRequestOptions;
}>): () => void {
  const runnerPid = params.runnerPid ?? process.pid;
  let revision = 0;
  return params.consumer.subscribeLiveWork(() => {
    const sessionId = params.readSessionId();
    void params.consumer.readLiveWork()
      .then(activity => {
        const report = { runnerPid, revision: ++revision, activity };
        logger.infoFile('[LIVE WORK] Runner report prepared', { sessionId, runnerPid, revision: report.revision,
          session: activity.session, input: activity.input, agents: activity.agents ?? 'absent' });
        return report;
      }, () => undefined)
      .then(liveWork => notifyDaemonSessionActivityChanged(sessionId, undefined, undefined, undefined, liveWork, params.daemon))
      .catch(params.onUnavailable);
  });
}
