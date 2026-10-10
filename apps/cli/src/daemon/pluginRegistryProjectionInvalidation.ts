import type { DaemonState } from '@/api/types';

type DaemonStateProjectionApiMachine = Readonly<{
  getContributionRegistryProjectionRevision?: () => number;
  updateDaemonState: (
    updater: (state: DaemonState | null) => DaemonState,
  ) => Promise<unknown>;
}>;

/**
 * Publishes plugin projection changes through the existing daemon-state
 * transport, independently of workspace, transfer and service updates.
 */
export function createDaemonPluginRegistryProjectionInvalidation(params: Readonly<{
  getApiMachine: () => DaemonStateProjectionApiMachine | null;
  isDaemonQuiescing: () => boolean;
  onPublicationFailure: (error: unknown) => void;
  onProjectionInvalidated?: (revision: number) => void;
}>): Readonly<{
  invalidateProjection: () => void;
  resume: () => void;
  readRevision: () => number;
}> {
  let hasPendingInvalidation = false;
  // One projection fact, owned here. Machine state is its published projection,
  // not a prerequisite for notifying local Sessions while the Home is offline.
  let contributionRegistryProjectionRevision = 0;
  const readRevision = () => {
    contributionRegistryProjectionRevision = Math.max(contributionRegistryProjectionRevision,
      params.getApiMachine()?.getContributionRegistryProjectionRevision?.() ?? 0);
    return contributionRegistryProjectionRevision;
  };

  const publish = (): void => {
    contributionRegistryProjectionRevision = readRevision() + 1;
    params.onProjectionInvalidated?.(contributionRegistryProjectionRevision);
    const apiMachine = params.getApiMachine();
    if (!apiMachine || params.isDaemonQuiescing()) return;
    void apiMachine.updateDaemonState((state) => ({
      ...(state ?? { status: 'running' as const, pid: process.pid }),
      contributionRegistryProjectionRevision: Math.max(state?.contributionRegistryProjectionRevision ?? 0, readRevision()),
    })).catch(params.onPublicationFailure);
  };

  return Object.freeze({
    readRevision,
    invalidateProjection: () => {
      if (params.isDaemonQuiescing()) {
        // A failed self-restart resumes this same daemon. One projection bump then
        // invalidates UI projections for every registry application it retained.
        hasPendingInvalidation = true;
        return;
      }
      hasPendingInvalidation = false;
      publish();
    },
    resume: () => {
      if (!hasPendingInvalidation || params.isDaemonQuiescing()) return;
      hasPendingInvalidation = false;
      publish();
    },
  });
}
