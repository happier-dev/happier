import { readSourceReloadRefusal } from '../runtime/shared/source_reload_refusal.mjs';

/** Project the existing lifecycle owners' evidence into one reload verdict. */
/** `enforceValidity` (QA train canary, owner 2026-11-18): the daemon-tree, sign-in and API-origin checks refuse READY only
 * on Stacks in the canary (`HAPPIER_STACK_QA_TRAIN=1`); elsewhere READY reports them under `validity` until the fleet default. */
export function projectStackReloadVerification({ info, beforeManagedCli, start, auth, agent, render, reload, signIn, failure, enforceValidity = true } = {}) {
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
  // The start owner left its live runner starting after the readiness budget:
  // no loaded identity exists yet, so an identity comparison would mislabel it.
  if (start?.readiness === 'pending') {
    return notReady('readiness', { status: 'pending', runner: 'live', runnerPid: start.runnerPid ?? null });
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
  // The daemon runs this reload's tree (owner 2026-11-18, QA train): selected == loaded holds for a daemon the
  // reload never reselected, so this reload's own record must carry a daemon capture of the server's revision.
  const validity = {};
  const invalid = (check, evidence) => { validity[check] = { status: 'failed', evidence }; return enforceValidity ? notReady(check, evidence) : null; };
  if (runtime.mode === 'source-snapshot') {
    const captures = reload?.sourceCaptures ?? {};
    const revision = captures.daemon?.revision ?? null;
    if (reload?.status !== 'ready' || reload.fresh !== true || !revision
      || (captures.server && captures.server.revision !== revision)) {
      const refused = invalid('daemon_tree', { fresh: reload?.fresh === true, daemon: revision, server: captures.server?.revision ?? null });
      if (refused) return refused;
    }
  }
  if (runtime.components?.daemon?.running !== true) {
    return notReady('control', { status: runtime.components?.daemon?.status ?? 'unavailable' });
  }
  if (runtime.daemonParticipants === null) return notReady('participants', { reason: 'participant_source_unknown' });
  for (const participant of runtime.daemonParticipants ?? []) {
    if (participant.reason) return notReady(`participant:${participant.identity}`, participant);
  }
  if (auth?.authenticated !== true) return notReady('auth', { authenticated: false });
  // A QA sign-in starts with the key challenge on the stack's canonical server (503 without a canonical URL).
  if (signIn?.status !== 200) { const refused = invalid('sign_in', { status: signIn?.status ?? null }); if (refused) return refused; }
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
  // The QA URL's page must talk to the server that URL names, not another Home it drifted to.
  if (info.urls?.uiUrl && (!render.apiOrigins?.length || !render.expectedApiOrigin
    || render.apiOrigins.some(origin => origin !== render.expectedApiOrigin))) {
    const refused = invalid('api_origin', { expected: render.expectedApiOrigin ?? null, observed: render.apiOrigins ?? [] });
    if (refused) return refused;
  }
  const sourceTimes = runtime.mode === 'source-snapshot' ? { sourceTimes: {
    server: runtime.sourceRuntimeIdentities?.server?.sourceTime ?? null,
    daemon: runtime.sourceRuntimeIdentities?.daemon?.sourceTime ?? null,
  } } : {};
  return { status: 'READY', ...baseline, ...participants, ...sourceTimes, ...(Object.keys(validity).length ? { validity } : {}), identities: runtime.sourceRuntimeIdentities ?? {
    snapshot: { selected: runtime.selectedSnapshotId, loaded: runtime.loadedSnapshotId },
  }, managedCli: afterManagedCli, agent, render: info.urls?.uiUrl ? render : { status: 'disabled' } };
}
