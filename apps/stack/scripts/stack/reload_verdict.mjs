import { readSourceReloadRefusal } from '../runtime/shared/source_reload_refusal.mjs';

/** Project the existing lifecycle owners' evidence into one reload verdict. */
export function projectStackReloadVerification({ info, beforeManagedCli, auth, agent, render, failure } = {}) {
  const runtime = info?.runtime;
  const hasBaseline = beforeManagedCli?.status === 'installed' && Boolean(beforeManagedCli.binaryPath);
  const baseline = hasBaseline ? {} : { baseline: 'unavailable' };
  const participants = runtime && Object.hasOwn(runtime, 'daemonParticipants') ? { participants: runtime.daemonParticipants } : {};
  const notReady = (check, evidence) => ({ status: 'NOT_READY', check, evidence, ...baseline, ...participants });
  if (failure) {
    const reason = failure.error?.reason ?? failure.error?.actions?.finalization?.reason;
    return notReady(failure.check, {
      code: failure.error?.code ?? null,
      ...(reason ? { reason } : {}),
      ...(failure.error?.pluginFailures ? { pluginFailures: readSourceReloadRefusal(failure.error).pluginFailures } : {}),
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
  if (runtime.daemonParticipants === null) return notReady('participants', { reason: 'participant_source_unknown' });
  for (const participant of runtime.daemonParticipants ?? []) {
    if (participant.reason) return notReady(`participant:${participant.identity}`, participant);
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
  // Health alone admitted stacks whose every Agent child exited before webhook.
  if (agent?.status !== 'ready') return notReady('agent', agent ?? { status: 'pending' });
  if (info.urls?.uiUrl && render?.status !== 'ready') {
    return notReady('render', { status: render?.status ?? 'pending' });
  }
  const sourceTimes = runtime.mode === 'source-snapshot' ? { sourceTimes: {
    server: runtime.sourceRuntimeIdentities?.server?.sourceTime ?? null,
    daemon: runtime.sourceRuntimeIdentities?.daemon?.sourceTime ?? null,
  } } : {};
  return { status: 'READY', ...baseline, ...participants, ...sourceTimes, identities: runtime.sourceRuntimeIdentities ?? {
    snapshot: { selected: runtime.selectedSnapshotId, loaded: runtime.loadedSnapshotId },
  }, managedCli: afterManagedCli, agent, render: info.urls?.uiUrl ? render : { status: 'disabled' } };
}
