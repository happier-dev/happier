function normalizeRuntimeMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'prefer') return 'prefer';
  if (value === 'require') return 'require';
  return 'source';
}

export function resolveStackRuntimeMode({ argv = [], env = process.env } = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const wantsRuntime = args.includes('--runtime');
  const wantsSource = args.includes('--source');

  if (wantsRuntime && wantsSource) {
    throw new Error('[runtime] --runtime and --source cannot be used together.');
  }

  if (wantsRuntime) {
    return { mode: 'require', source: 'flag' };
  }
  if (wantsSource) {
    return { mode: 'source', source: 'flag' };
  }

  if (Object.prototype.hasOwnProperty.call(env ?? {}, 'HAPPIER_STACK_RUNTIME_MODE')) {
    return {
      mode: normalizeRuntimeMode(env?.HAPPIER_STACK_RUNTIME_MODE),
      source: 'env',
    };
  }

  return { mode: 'source', source: 'default' };
}
