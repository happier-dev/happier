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

export function resolveStackRuntimeMode({ argv = [], env = process.env, activeRuntimeState = null } = {}) {
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
    return { mode: runtimeValue === 'source' ? 'source-snapshot' : 'require', source: 'flag' };
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
