export function resolveAuthForceFlag({ flags, kv } = {}) {
  const fromFlag = Boolean(flags && typeof flags.has === 'function' && flags.has('--force'));
  const fromKv = String(kv && typeof kv.get === 'function' ? (kv.get('--force') ?? '') : '')
    .trim()
    .toLowerCase();
  return fromFlag || fromKv === '1' || fromKv === 'true' || fromKv === 'yes';
}

export function applyAuthForceEnv(env, force) {
  const base = env && typeof env === 'object' ? env : {};
  if (!force) return base;
  return { ...base, HAPPIER_AUTH_FORCE: '1' };
}

