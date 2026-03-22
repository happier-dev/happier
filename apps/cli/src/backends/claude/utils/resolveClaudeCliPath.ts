import { createRequire } from 'node:module';

import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';

type ClaudeVersionUtilsModule = {
  getClaudeCliPath: () => string;
};

let cachedResolvedClaudeCliPath: string | null = null;

export function resolveClaudeCliPath(): string {
  if (cachedResolvedClaudeCliPath) {
    return cachedResolvedClaudeCliPath;
  }

  const require = createRequire(import.meta.url);
  const utilsPath = resolveCliRuntimeAssetPath('scripts', 'claude_version_utils.cjs');
  const mod = require(utilsPath) as ClaudeVersionUtilsModule;

  if (!mod || typeof mod.getClaudeCliPath !== 'function') {
    throw new Error('Claude version utils module does not export getClaudeCliPath()');
  }

  cachedResolvedClaudeCliPath = mod.getClaudeCliPath();
  return cachedResolvedClaudeCliPath;
}

export function isClaudeCliJavaScriptFile(cliPath: string): boolean {
  const normalized = typeof cliPath === 'string' ? cliPath.trim() : '';
  return normalized.endsWith('.js') || normalized.endsWith('.cjs') || normalized.endsWith('.mjs');
}
