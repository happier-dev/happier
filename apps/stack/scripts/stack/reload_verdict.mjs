/** Project the existing lifecycle owners' evidence into one reload verdict. */
export function projectStackReloadVerification({ info, beforeManagedCli, auth, render, failure } = {}) {
  const runtime = info?.runtime;
  const hasBaseline = beforeManagedCli?.status === 'installed' && Boolean(beforeManagedCli.binaryPath);
  const baseline = hasBaseline ? {} : { baseline: 'unavailable' };
  const notReady = (check, evidence) => ({ status: 'NOT_READY', check, evidence, ...baseline });
  if (failure) {
    const reason = failure.error?.actions?.finalization?.reason;
    return notReady(failure.check, {
      code: failure.error?.code ?? null,
      ...(reason ? { reason } : {}),
    });
  }
  if (!runtime?.running || runtime.valid !== true) {
    return notReady('readiness', { running: runtime?.running === true, valid: runtime?.valid === true });
  }
  if (runtime.mode === 'source-snapshot') {
    for (const component of new Set(['server', 'daemon', ...Object.keys(runtime.sourceRuntimeIdentities ?? {})])) {
      const identity = runtime.sourceRuntimeIdentities?.[component];
      if (!identity?.selected || identity.loaded !== identity.selected) {
        return notReady(`identity:${component}`, { selected: identity?.selected ?? null, loaded: identity?.loaded ?? null });
      }
    }
    const daemonEntry = runtime.daemonEntry;
    if (!daemonEntry?.selected || daemonEntry.loaded !== daemonEntry.selected) {
      return notReady('daemon_entry_mismatch', {
        selected: daemonEntry?.selected ?? null, loaded: daemonEntry?.loaded ?? null,
      });
    }
  } else if (!runtime.selectedSnapshotId || runtime.selectedSnapshotId !== runtime.loadedSnapshotId) {
    return notReady('identity:snapshot', { selected: runtime.selectedSnapshotId ?? null, loaded: runtime.loadedSnapshotId ?? null });
  }
  if (runtime.components?.daemon?.running !== true) {
    return notReady('control', { status: runtime.components?.daemon?.status ?? 'unavailable' });
  }
  if (auth?.authenticated !== true) return notReady('auth', { authenticated: false });
  if (runtime.health?.status !== 'healthy') {
    return notReady('readiness', { status: runtime.health?.status ?? 'unavailable', issues: runtime.health?.issues ?? [] });
  }
  const afterManagedCli = runtime.managedCli;
  if (afterManagedCli?.status !== 'installed' || !afterManagedCli.binaryPath
    || (hasBaseline && beforeManagedCli.binaryPath !== afterManagedCli.binaryPath)) {
    return notReady('managed-cli', { before: beforeManagedCli ?? null, after: afterManagedCli ?? null });
  }
  if (info.urls?.uiUrl && render?.status !== 'ready') {
    return notReady('render', { status: render?.status ?? 'pending' });
  }
  return { status: 'READY', ...baseline, identities: runtime.sourceRuntimeIdentities ?? {
    snapshot: { selected: runtime.selectedSnapshotId, loaded: runtime.loadedSnapshotId },
  }, managedCli: afterManagedCli, render: info.urls?.uiUrl ? render : { status: 'disabled' } };
}
