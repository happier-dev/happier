// @ts-check

/**
 * @param {{ env: Record<string, string | undefined>; dryRun: boolean }} opts
 */
export function shouldStageRepoForEasLocalBuild(opts) {
  if (opts.dryRun) return false;
  const env = opts.env ?? {};
  const hasDaggerSession = Boolean(
    env.HAPPIER_PIPELINE_LOCAL_RUNTIME === 'dagger' || env.DAGGER_SESSION_TOKEN || env.DAGGER_SESSION_PORT,
  );
  // When running inside Dagger, the mounted repo is already ephemeral, so staging adds a lot of
  // extra filesystem churn and can explode the engine cache. Prefer building in-place.
  if (hasDaggerSession) return false;
  return true;
}
