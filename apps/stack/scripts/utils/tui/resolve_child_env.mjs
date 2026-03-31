import { mergeEnvForTuiSummary } from './summary_env.mjs';
import { buildTauriPaneEnv } from './tauri_mode.mjs';

export function resolveTuiChildEnv({
  stackEnvFromFile,
  processEnv = process.env,
  resolveUserHomeDir,
} = {}) {
  const mergedEnv = mergeEnvForTuiSummary({
    stackEnvFromFile,
    processEnv,
  });
  return buildTauriPaneEnv({ env: mergedEnv, resolveUserHomeDir });
}

