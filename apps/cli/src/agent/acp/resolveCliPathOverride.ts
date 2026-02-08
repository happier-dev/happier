import { accessSync, constants as fsConstants } from 'node:fs';

export function resolveCliPathOverride(params: { agentId: string }): string | null {
  const isWindows = process.platform === 'win32';
  const accessMode = isWindows ? fsConstants.F_OK : fsConstants.X_OK;
  const envKey = `HAPPIER_${params.agentId.toUpperCase()}_PATH`;
  const override = typeof process.env[envKey] === 'string' ? String(process.env[envKey]).trim() : '';
  if (!override) return null;

  try {
    accessSync(override, accessMode);
    return override;
  } catch {
    return null;
  }
}

