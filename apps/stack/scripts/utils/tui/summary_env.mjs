export function mergeEnvForTuiSummary({ stackEnvFromFile, processEnv = process.env } = {}) {
  const fileEnv = stackEnvFromFile && typeof stackEnvFromFile === 'object' ? stackEnvFromFile : {};
  const procEnv = processEnv && typeof processEnv === 'object' ? processEnv : {};
  // Prefer process env (it reflects all overlays and wrapper overrides).
  return { ...fileEnv, ...procEnv };
}

