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

  // Staging into a temp directory is intentionally opt-in:
  // - it breaks config evaluation when the app config relies on workspace-resolved imports
  //   (staged repo has no monorepo node_modules by default),
  // - it can trigger fingerprint runtimeVersion drift when dependency resolution differs between
  //   config evaluation and the actual build environment.
  const raw = String(env.HAPPIER_PIPELINE_STAGE_EAS_LOCAL_BUILD ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  return false;
}
