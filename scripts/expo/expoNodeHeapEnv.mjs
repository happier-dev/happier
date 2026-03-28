// @ts-check

const DEFAULT_EXPO_MAX_OLD_SPACE_SIZE_MB = 8192;
const MAX_OLD_SPACE_SIZE_REGEX = /(^|\s)--max-old-space-size(=|\s)\d+(\s|$)/g;

function coercePositiveInt(value) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function parseExpoMaxOldSpaceSizeMb(env, envKey = 'HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB') {
  const raw = String(env?.[envKey] ?? '').trim();
  if (!raw) return { explicit: false, value: null };
  if (raw === '0') return { explicit: true, value: 0 };
  return { explicit: true, value: coercePositiveInt(raw) };
}

export function setOrReplaceMaxOldSpaceSizeFlag(nodeOptions, sizeMb) {
  const base = String(nodeOptions ?? '').trim();
  const desired = `--max-old-space-size=${sizeMb}`;
  if (!base) return desired;

  const replaced = base.replace(MAX_OLD_SPACE_SIZE_REGEX, `$1${desired}$3`).trim();
  if (replaced !== base) return replaced;

  return `${base} ${desired}`.trim();
}

export function applyExpoNodeHeapEnv(baseEnv, options = {}) {
  const env = /** @type {Record<string, string>} */ ({ ...(baseEnv ?? process.env) });
  const envKey = String(options.envKey ?? 'HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB');
  const defaultSizeMb = Number.isFinite(options.defaultSizeMb) && options.defaultSizeMb > 0
    ? Math.floor(options.defaultSizeMb)
    : DEFAULT_EXPO_MAX_OLD_SPACE_SIZE_MB;

  const { explicit, value } = parseExpoMaxOldSpaceSizeMb(env, envKey);
  if (explicit && value === 0) return env;

  const desired = explicit && typeof value === 'number' ? value : defaultSizeMb;
  env.NODE_OPTIONS = setOrReplaceMaxOldSpaceSizeFlag(env.NODE_OPTIONS ?? '', desired);
  return env;
}
