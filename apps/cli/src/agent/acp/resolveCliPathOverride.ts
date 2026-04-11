import { accessSync, constants as fsConstants } from 'node:fs';

import { resolveWindowsCommandOnPath, resolveWindowsCommandPath } from '@happier-dev/cli-common/process';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export function resolveCliPathOverride(params: { agentId: string }): string | null {
  const isWindows = process.platform === 'win32';
  const accessMode = isWindows ? fsConstants.F_OK : fsConstants.X_OK;
  const envKey = `HAPPIER_${params.agentId.toUpperCase()}_PATH`;
  const override = expandHomeDirPath(typeof process.env[envKey] === 'string' ? String(process.env[envKey]).trim() : '', process.env);
  if (!override) return null;

  if (isWindows) {
    const normalizedOverride =
      (override.includes('/') || override.includes('\\') || override.includes(':'))
        ? resolveWindowsCommandPath(override, process.env)
        : resolveWindowsCommandOnPath(override, process.env);
    if (normalizedOverride) return normalizedOverride;
  }

  try {
    accessSync(override, accessMode);
    return override;
  } catch {
    return null;
  }
}
