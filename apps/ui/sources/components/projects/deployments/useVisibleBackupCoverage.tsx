import * as React from 'react';
import type { ProjectReadinessReadInputV1 } from '@happier-dev/protocol/projects/readinessV1';

import { useProjectReadiness } from '@/components/projects/widgets/useProjectReadiness';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import {
  planVisibleBackupReadiness,
  projectBackupCoverage,
  type BackupReadinessObservation,
} from './deploymentBackupCoverage';

type VisibleEnvironment = Parameters<
  typeof planVisibleBackupReadiness
>[0][number];
type ReaderObservation = BackupReadinessObservation &
  Readonly<{ refresh: () => Promise<void> }>;

const requestKey = (input: ProjectReadinessReadInputV1) =>
  JSON.stringify(input);

/**
 * Backup coverage for the Environments a page shows: one existing `projects.readiness.read` per (Home, Project Source,
 * Machine) group, planned by the coverage projection, while the page is presented. Every coverage decision stays with
 * the readiness owner; this only carries each group's read to the projection. `readers` must be rendered.
 */
export function useVisibleBackupCoverage(
  lifetime: ServerAccountScopeLifetime | null,
  visible: readonly VisibleEnvironment[],
  presented: boolean,
) {
  const requests = React.useMemo(
    () => planVisibleBackupReadiness(visible, presented && lifetime !== null),
    [visible, presented, lifetime],
  );
  const [observations, setObservations] = React.useState<
    ReadonlyMap<string, ReaderObservation>
  >(() => new Map());
  const report = useEventCallback(
    (key: string, observation: ReaderObservation | null) => {
      setObservations((previous) => {
        if (
          observation === null
            ? !previous.has(key)
            : previous.get(key) === observation
        )
          return previous;
        const next = new Map(previous);
        if (observation === null) next.delete(key);
        else next.set(key, observation);
        return next;
      });
    },
  );
  const current = React.useMemo(
    () =>
      requests.flatMap((input) => {
        const observation = observations.get(requestKey(input));
        return observation && observation.input === input ? [observation] : [];
      }),
    [requests, observations],
  );
  const coverage = React.useMemo(
    () => projectBackupCoverage(visible, current),
    [visible, current],
  );
  const retry = useEventCallback(() => {
    for (const observation of current) {
      if (observation.failureCode !== null && !observation.pending)
        void observation.refresh();
    }
  });
  const readers =
    lifetime === null
      ? null
      : requests.map((input) => (
          <BackupReadinessReader
            key={requestKey(input)}
            lifetime={lifetime}
            input={input}
            report={report}
          />
        ));
  return {
    coverage: presented && lifetime !== null ? coverage : null,
    readers,
    retry,
  };
}

/** One group's readiness read; it draws nothing and reports what the readiness owner answered. */
function BackupReadinessReader(
  props: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    input: ProjectReadinessReadInputV1;
    report: (key: string, observation: ReaderObservation | null) => void;
  }>,
) {
  const { lifetime, input, report } = props;
  const { result, pending, failureCode, refresh } = useProjectReadiness(
    lifetime,
    input,
    true,
  );
  const key = requestKey(input);
  React.useEffect(() => {
    report(key, { input, result, pending, failureCode, refresh });
  }, [report, key, input, result, pending, failureCode, refresh]);
  React.useEffect(() => () => report(key, null), [report, key]);
  return null;
}
