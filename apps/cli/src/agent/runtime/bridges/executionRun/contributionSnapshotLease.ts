export function executionRunContributionSnapshotUnavailable(): Error & { code: string } {
  return Object.assign(
    new Error('A current execution-run contribution snapshot is unavailable'),
    { code: 'execution_run_contribution_snapshot_unavailable' },
  );
}

export function createExecutionRunSnapshotLease(
  release: (() => Promise<void>) | undefined,
): Readonly<{
  retain(): () => Promise<void>;
  releaseOwner(): Promise<void>;
}> {
  let references = 1;
  let released = false;
  let releasePromise: Promise<void> | null = null;

  const releaseReference = (): Promise<void> => {
    if (references <= 0) return releasePromise ?? Promise.resolve();
    references -= 1;
    if (references > 0) return Promise.resolve();
    released = true;
    releasePromise ??= Promise.resolve().then(async () => {
      await release?.();
    });
    return releasePromise;
  };

  return Object.freeze({
    retain() {
      if (released || references <= 0) {
        throw executionRunContributionSnapshotUnavailable();
      }
      references += 1;
      let retained = true;
      return async () => {
        if (!retained) return;
        retained = false;
        await releaseReference();
      };
    },
    releaseOwner: releaseReference,
  });
}
