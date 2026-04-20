import { existsSync as defaultExistsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export function resolveTypeScriptCliInvocation(params) {
  const processExecPath = params.processExecPath ?? process.execPath;
  const requireResolve = params.requireResolve ?? createRequire(import.meta.url).resolve;
  const existsSync = params.existsSync ?? defaultExistsSync;
  const platform = params.platform ?? process.platform;
  const workspaceDir = typeof params.workspaceDir === 'string' && params.workspaceDir.length > 0 ? params.workspaceDir : null;

  try {
    const tscJs = requireResolve('typescript/lib/tsc.js');
    return {
      command: processExecPath,
      argsPrefix: [tscJs],
    };
  } catch {
    const binName = platform === 'win32' ? 'tsc.cmd' : 'tsc';
    const candidates = [
      resolve(params.repoRoot, 'node_modules', '.bin', binName),
      workspaceDir ? resolve(workspaceDir, 'node_modules', '.bin', binName) : null,
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { command: candidate, argsPrefix: [] };
      }
    }

    return { command: candidates[0], argsPrefix: [] };
  }
}
