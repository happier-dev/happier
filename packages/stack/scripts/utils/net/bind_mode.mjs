export function normalizeBindMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'loopback' || v === 'lan') return v;
  return null;
}

export function resolveBindModeFromArgs({ flags, kv }) {
  if (flags?.has?.('--loopback')) return 'loopback';
  if (flags?.has?.('--lan')) return 'lan';
  const raw = kv?.get?.('--bind');
  return normalizeBindMode(raw);
}

/**
 * Apply a bind mode override to an env object.
 *
 * Semantics:
 * - loopback: prefer localhost-only origins/advertising (best for port-forwarded / isolated environments)
 * - lan: prefer LAN origins/advertising (best for phones on the same network)
 *
 * This currently controls Expo's `--host` via HAPPY_STACKS_EXPO_HOST.
 * Other services may optionally honor HOST=127.0.0.1 when loopback is selected.
 */
export function applyBindModeToEnv(env, mode) {
  const m = normalizeBindMode(mode);
  if (!m) return env;

  env.HAPPY_STACKS_BIND_MODE = m;
  env.HAPPY_LOCAL_BIND_MODE = m;

  if (m === 'loopback') {
    env.HAPPY_STACKS_EXPO_HOST = 'localhost';
    env.HAPPY_LOCAL_EXPO_HOST = 'localhost';
    // Best-effort: some servers honor HOST.
    env.HOST = '127.0.0.1';
  } else if (m === 'lan') {
    env.HAPPY_STACKS_EXPO_HOST = 'lan';
    env.HAPPY_LOCAL_EXPO_HOST = 'lan';
  }

  return env;
}

