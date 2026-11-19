function isEnabled(value) {
  return ['1', 'true', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase());
}

export function shouldUseCliSourceEntrypoint(env) {
  return isEnabled(env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT
    ?? env.HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT);
}

export function shouldSkipServerSharedDepsBuild(env) {
  return isEnabled(env.HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD
    ?? env.HAPPY_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD);
}
