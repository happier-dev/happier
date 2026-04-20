import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function resolveInferenceModelsRootDir(params: Readonly<{ ownerRootDir: string }>): string {
  return join(params.ownerRootDir, 'models');
}

export function resolveInferenceCacheDir(params: Readonly<{ modelsRootDir: string; runtimeId: string }>): string {
  return join(params.modelsRootDir, params.runtimeId);
}

export function ensurePrivateInferenceDirectory(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
  if (process.platform === 'win32') {
    return;
  }
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // best-effort
  }
}
