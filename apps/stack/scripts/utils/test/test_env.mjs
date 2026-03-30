export function readBooleanEnvFlag(env, name, fallback = false) {
  const raw = env && typeof env === 'object' ? env[name] : undefined;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false;
  return fallback;
}

export function sanitizeDefinedEnv(env = {}) {
  const cleanEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value == null) continue;
    cleanEnv[key] = String(value);
  }
  return cleanEnv;
}
