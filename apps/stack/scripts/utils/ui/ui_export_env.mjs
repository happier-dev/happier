export function buildStackWebExportEnv({ baseEnv } = {}) {
  const env = { ...(baseEnv || process.env) };

  // This is a stack-built bundle (served by the stack server), so ensure the app
  // behaves like stack context at runtime (no Cloud seeding/locking).
  env.NODE_ENV = 'production';
  env.EXPO_PUBLIC_DEBUG = '0';
  env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';

  // Leave empty so the web bundle uses window.location.origin at runtime.
  env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';

  return env;
}

export function buildStackTauriExportEnv({ baseEnv, tauriServerUrl } = {}) {
  const env = { ...(baseEnv || process.env) };

  env.NODE_ENV = 'production';
  env.EXPO_PUBLIC_DEBUG = '0';
  env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';

  // In Tauri, window.location.origin is a tauri:// origin, so hardcode the API base.
  env.EXPO_PUBLIC_HAPPY_SERVER_URL = String(tauriServerUrl || '').trim();
  env.EXPO_PUBLIC_SERVER_URL = env.EXPO_PUBLIC_HAPPY_SERVER_URL;

  return env;
}

