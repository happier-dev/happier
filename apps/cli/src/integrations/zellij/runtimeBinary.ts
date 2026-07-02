import { existsSync } from 'node:fs';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

import { resolveZellijBinary } from './resolveZellijBinary';

export const BUNDLED_ZELLIJ_VERSION = '0.44.3';

export function resolveZellijToolsDir(): string {
  const installedToolsDir = resolveCliRuntimeAssetPath('tools', 'unpacked');
  if (existsSync(installedToolsDir)) return installedToolsDir;
  return resolveCliRuntimeAssetPath('apps', 'cli', 'tools', 'unpacked');
}

export async function resolveZellijRuntimeBinary(params: Readonly<{
  expectedVersion?: string;
}> = {}): Promise<string | null> {
  return await resolveZellijBinary({
    toolsDir: resolveZellijToolsDir(),
    expectedVersion: params.expectedVersion ?? BUNDLED_ZELLIJ_VERSION,
  });
}
