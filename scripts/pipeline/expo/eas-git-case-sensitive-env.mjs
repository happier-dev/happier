// @ts-check

/**
 * Force EAS subprocesses on macOS to evaluate git paths with case sensitivity enabled,
 * without persisting a repo config change.
 *
 * @param {Record<string, string | undefined>} baseEnv
 * @returns {Record<string, string>}
 */
export function withEasGitCaseSensitiveEnv(baseEnv) {
  const env = /** @type {Record<string, string>} */ ({ ...baseEnv });
  if (process.platform !== 'darwin') return env;

  const rawCount = String(env.GIT_CONFIG_COUNT ?? '').trim();
  const parsedCount = rawCount ? Number.parseInt(rawCount, 10) : 0;
  const safeCount = Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : 0;

  for (let index = 0; index < safeCount; index += 1) {
    if (env[`GIT_CONFIG_KEY_${index}`] === 'core.ignorecase') {
      env[`GIT_CONFIG_VALUE_${index}`] = 'false';
      return env;
    }
  }

  env.GIT_CONFIG_COUNT = String(safeCount + 1);
  env[`GIT_CONFIG_KEY_${safeCount}`] = 'core.ignorecase';
  env[`GIT_CONFIG_VALUE_${safeCount}`] = 'false';
  return env;
}
