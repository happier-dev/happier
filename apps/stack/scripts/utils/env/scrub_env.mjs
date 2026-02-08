export const SANDBOX_PRESERVE_KEYS = [
  'HAPPIER_STACK_VERBOSE',
  'HAPPIER_STACK_INVOKED_CWD',
  'HAPPIER_STACK_SANDBOX_DIR',
  'HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL',
  'HAPPIER_STACK_UPDATE_CHECK',
  'HAPPIER_STACK_UPDATE_CHECK_INTERVAL_MS',
  'HAPPIER_STACK_UPDATE_NOTIFY_INTERVAL_MS',
];

export const STACK_WRAPPER_PRESERVE_KEYS = [
  // Stack/env pointers:
  'HAPPIER_STACK_ENV_FILE',
  'HAPPIER_STACK_STACK',

  // Sandbox detection + policy.
  'HAPPIER_STACK_SANDBOX_DIR',
  'HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL',

  // Sandbox-enforced dirs.
  'HAPPIER_STACK_CLI_ROOT_DISABLE',
  'HAPPIER_STACK_CANONICAL_HOME_DIR',
  'HAPPIER_STACK_HOME_DIR',
  'HAPPIER_STACK_WORKSPACE_DIR',
  'HAPPIER_STACK_RUNTIME_DIR',
  'HAPPIER_STACK_STORAGE_DIR',

  // UX knobs.
  'HAPPIER_STACK_VERBOSE',
  'HAPPIER_STACK_UPDATE_CHECK',
  'HAPPIER_STACK_UPDATE_CHECK_INTERVAL_MS',
  'HAPPIER_STACK_UPDATE_NOTIFY_INTERVAL_MS',

  // Guided auth flow coordination across wrappers.
  'HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH',
  'HAPPIER_STACK_AUTH_FLOW',

  // Safe global defaults.
  'HAPPIER_STACK_STACK_PORT_START',

  'HAPPIER_STACK_BIND_MODE',
  'HAPPIER_STACK_EXPO_HOST',

  // Expo dev-server port strategy.
  'HAPPIER_STACK_EXPO_DEV_PORT',
  'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY',
  'HAPPIER_STACK_EXPO_DEV_PORT_BASE',
  'HAPPIER_STACK_EXPO_DEV_PORT_RANGE',
];

export function scrubHappierStackEnv(
  env,
  { keepHappierStackKeys = [], clearUnprefixedKeys = [] } = {},
) {
  const input = env && typeof env === 'object' ? env : {};
  const out = { ...input };
  const keep = new Set((keepHappierStackKeys ?? []).map((k) => String(k).trim()).filter(Boolean));
  for (const k of Object.keys(out)) {
    if (k.startsWith('HAPPIER_STACK_') && !keep.has(k)) {
      delete out[k];
    }
  }
  for (const k of (clearUnprefixedKeys ?? []).map((x) => String(x).trim()).filter(Boolean)) {
    delete out[k];
  }
  return out;
}

