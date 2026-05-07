import { basename } from 'node:path';

import { resolvePackagedRuntimeEntrypoint } from '@/runtime/resolvePackagedRuntimeEntrypoint';

const JAVA_SCRIPT_RUNTIME_BASENAMES = new Set([
  'node',
  'node.exe',
  'bun',
  'bun.exe',
  'happier-js-runtime',
  'happier-js-runtime.cmd',
]);

function normalizeBasename(pathLike: string | null | undefined): string {
  return basename(String(pathLike ?? '').trim()).toLowerCase();
}

function isJavaScriptRuntimeExecutable(pathLike: string | null | undefined): boolean {
  return JAVA_SCRIPT_RUNTIME_BASENAMES.has(normalizeBasename(pathLike));
}

function resolveBundledDaemonEntrypoint(): string {
  return resolvePackagedRuntimeEntrypoint('index.mjs', { packageDistOnly: true });
}

export function resolveDaemonServiceRuntimeTarget(params: Readonly<{
  currentExecPath?: string | null;
  runtimeExecutable?: string | null;
  explicitNodePath?: string | null;
  explicitEntryPath?: string | null;
}>): Readonly<{
  nodePath: string;
  entryPath: string;
}> {
  const currentExecPath = String(params.currentExecPath ?? process.execPath).trim();
  const explicitNodePath = String(params.explicitNodePath ?? '').trim();
  const explicitEntryPath = String(params.explicitEntryPath ?? '').trim();
  const runtimeExecutable = String(params.runtimeExecutable ?? '').trim();

  const nodePath = explicitNodePath || runtimeExecutable || currentExecPath;
  if (!nodePath) {
    throw new Error('Daemon service runtime command is required');
  }

  if (explicitEntryPath) {
    return { nodePath, entryPath: explicitEntryPath };
  }

  if (isJavaScriptRuntimeExecutable(nodePath)) {
    return { nodePath, entryPath: resolveBundledDaemonEntrypoint() };
  }

  return { nodePath, entryPath: '' };
}
