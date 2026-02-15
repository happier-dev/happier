import os from 'node:os';
import path from 'node:path';

function normalizeEnvPath(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function assertFilesystemSafeStackName(raw: string): string {
  const stack = raw.trim();
  if (!stack) {
    throw new Error('Invalid stack name: empty');
  }
  if (stack === '.' || stack === '..') {
    throw new Error(`Invalid stack name: ${stack}`);
  }
  // Prevent directory traversal (path.join treats separators as path segments).
  if (stack.includes('/') || stack.includes('\\')) {
    throw new Error(`Invalid stack name: ${stack}`);
  }
  return stack;
}

export function resolveStackToolTraceDir(params: {
  stack: string;
  env?: Record<string, string | undefined>;
}): string {
  const stack = assertFilesystemSafeStackName(params.stack);
  const env = params.env ?? process.env;

  const storageOverride = normalizeEnvPath(env.HAPPIER_STACK_STORAGE_DIR);
  const stacksRoot = storageOverride ?? path.join(os.homedir(), '.happier', 'stacks');

  return path.join(stacksRoot, stack, 'cli', 'tool-traces');
}
