import * as React from 'react';
import type { WorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { getStorage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { sync } from '@/sync/sync';
import { WorkerUpdateCard } from './WorkerUpdateCard';

type RetainedRunReport = Readonly<{
  messageId: string;
  update: WorkerUpdateV1;
  at: number;
}>;
type RunReportSelection = Readonly<{
  loaded: boolean;
  report: RetainedRunReport | null;
}>;
const NOT_LOADED: RunReportSelection = Object.freeze({
  loaded: false,
  report: null,
});

/**
 * The retained report of one Execution Run, as its host Session's transcript holds it (the `worker-update`
 * the Run posted on settling), drawn by the one `WorkerUpdateCard`. The transcript's own latest-report
 * projection names the row; nothing else is read. A Session this device has not read starts its ordinary
 * first transcript read; a report outside the read window, or a Session in another Home, shows `fallback`.
 */
export function RunReportCard(
  props: Readonly<{
    serverId: string;
    run: Readonly<{ sessionId: string; runId: string }>;
    fallback?: React.ReactNode;
    testID?: string;
  }>,
): React.ReactElement {
  const activeServerId = useActiveServerSnapshot(true).serverId;
  const sameHome =
    Boolean(activeServerId) &&
    areServerProfileIdentifiersEquivalent(activeServerId, props.serverId);
  const { sessionId, runId } = props.run;
  // One stable selection: the store re-runs it on each notification and compares by identity.
  const selector = React.useMemo(() => {
    const address = normalizeSessionAddress(props.serverId, sessionId);
    let last = NOT_LOADED;
    return (state: StorageState): RunReportSelection => {
      const transcript = sameHome
        ? readStoredSessionTranscriptForAddress(state, address, {
            activeServerId,
          })
        : null;
      const messageId =
        transcript?.latestWorkerUpdates?.execution_run?.[runId]?.messageId;
      const message = messageId
        ? transcript?.messagesById?.[messageId]
        : undefined;
      const update =
        message?.kind === 'agent-event' &&
        message.event.type === 'worker-update'
          ? message.event.update
          : null;
      const loaded = transcript?.isLoaded === true;
      const report =
        update && messageId
          ? last.report?.messageId === messageId &&
            last.report.update === update
            ? last.report
            : { messageId, update, at: message?.createdAt ?? 0 }
          : null;
      if (last.loaded !== loaded || last.report !== report)
        last = { loaded, report };
      return last;
    };
  }, [activeServerId, props.serverId, runId, sameHome, sessionId]);
  const { loaded, report } = getStorage()(selector, {
    sessionMessages: [sessionId],
  });
  React.useEffect(() => {
    if (sameHome && !loaded) sync.onSessionOpenRequested(sessionId);
  }, [loaded, sameHome, sessionId]);
  if (!report) return <>{props.fallback ?? null}</>;
  return (
    <AppSessionTranscriptSourceProvider
      sessionId={sessionId}
      serverId={props.serverId}
    >
      <WorkerUpdateCard
        update={report.update}
        serverId={props.serverId}
        at={report.at}
      />
    </AppSessionTranscriptSourceProvider>
  );
}
