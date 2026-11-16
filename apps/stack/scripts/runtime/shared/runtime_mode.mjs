function normalizeRuntimeMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'source-snapshot') return value;
  if (value === 'prefer') return 'prefer';
  if (value === 'require') return 'require';
  return 'source';
}

function stackRuntimeModeArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const separator = args.indexOf('--');
  return separator === -1 ? args : args.slice(0, separator);
}

export function hasExplicitStackRuntimeModeArg(args = []) {
  const modeArgs = stackRuntimeModeArgs(args);
  return modeArgs.some(arg => arg === '--runtime' || arg.startsWith('--runtime=') || arg === '--source');
}

/** Committed mode (`HAPPIER_STACK_RUNTIME_MODE=committed`, owner 2026-11-16): live
 * mode (`stack dev`: Metro HMR, server and daemon watchers) rooted at a stable
 * committed worktree (`HAPPIER_STACK_REPO_DIR`) that committed_head_follower.mjs
 * fast-forwards to the newest HEAD of its primary checkout. `live` (the default)
 * runs the shared checkout itself, uncommitted edits included. */
export function isCommittedSourceMode(env = process.env) {
  return String(env?.HAPPIER_STACK_RUNTIME_MODE ?? '').trim().toLowerCase() === 'committed';
}

export function resolveStackRuntimeMode({ argv = [], env = process.env, activeRuntimeState = null } = {}) {
  const resolved = resolveStackRuntimeModeOnly({ argv, env, activeRuntimeState });
  return resolved.mode === 'source' && isCommittedSourceMode(env) ? { ...resolved, committed: true } : resolved;
}

function resolveStackRuntimeModeOnly({ argv, env, activeRuntimeState }) {
  const args = stackRuntimeModeArgs(argv);
  const runtimeValue = args.find(arg => arg.startsWith('--runtime='))?.slice('--runtime='.length);
  if (runtimeValue !== undefined && !['source', 'built'].includes(runtimeValue)) {
    throw new Error(`[runtime] invalid --runtime=${runtimeValue} (expected source|built).`);
  }
  const wantsRuntime = args.includes('--runtime') || runtimeValue !== undefined;
  const wantsSource = args.includes('--source');

  if (wantsRuntime && wantsSource) {
    throw new Error('[runtime] --runtime and --source cannot be used together.');
  }

  if (wantsRuntime) {
    const followsLoadedSourceDaemon = runtimeValue === undefined
      && Boolean(activeRuntimeState?.sourceRuntimeIdentities?.daemon?.loaded);
    return { mode: runtimeValue === 'source' || followsLoadedSourceDaemon
      ? 'source-snapshot' : 'require', source: 'flag' };
  }
  if (wantsSource) {
    return { mode: 'source', source: 'flag' };
  }

  if (activeRuntimeState?.sourceRuntimeIdentities && Object.keys(activeRuntimeState.sourceRuntimeIdentities).length) {
    return { mode: 'source-snapshot', source: 'active-runtime' };
  }
  if (
    activeRuntimeState &&
    typeof activeRuntimeState === 'object' &&
    Object.prototype.hasOwnProperty.call(activeRuntimeState, 'runtimeSnapshotId') &&
    activeRuntimeState.runtimeSnapshotId === null
  ) {
    return { mode: 'source', source: 'active-runtime' };
  }

  if (Object.prototype.hasOwnProperty.call(env ?? {}, 'HAPPIER_STACK_RUNTIME_MODE')) {
    return {
      mode: normalizeRuntimeMode(env?.HAPPIER_STACK_RUNTIME_MODE),
      source: 'env',
    };
  }

  return { mode: 'source', source: 'default' };
}
