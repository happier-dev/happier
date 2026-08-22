import type { DaemonState } from '@/api/types';

type DaemonStateProjectionApiMachine = Readonly<{
  updateDaemonState: (
    updater: (state: DaemonState | null) => DaemonState,
  ) => Promise<unknown>;
}>;

/**
 * Bridges a durable plugin-registry application to the existing daemon-state
 * version signal consumed by the UI.
 */
export function createDaemonPluginRegistryProjectionInvalidation(params: Readonly<{
  getApiMachine: () => DaemonStateProjectionApiMachine | null;
  isDaemonQuiescing: () => boolean;
  onPublicationFailure: (error: unknown) => void;
}>): Readonly<{
  onDurableRegistryApplied: () => void;
  resume: () => void;
}> {
  let hasPendingInvalidation = false;

  const publish = (): void => {
    const apiMachine = params.getApiMachine();
    if (!apiMachine || params.isDaemonQuiescing()) return;
    void apiMachine.updateDaemonState((state) => (
      state ?? { status: 'running' as const, pid: process.pid }
    )).catch(params.onPublicationFailure);
  };

  return Object.freeze({
    onDurableRegistryApplied: () => {
      if (params.isDaemonQuiescing()) {
        // A failed self-restart resumes this same daemon. One version bump then
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
