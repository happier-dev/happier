import { isTuiStartLikeForwardedArgs } from './args.mjs';
import { buildTauriRuntimeEnv } from '../dev/tauri_dev.mjs';
import { join } from 'node:path';
import { getRepoDir } from '../paths/paths.mjs';

export function buildTuiChildArgs({ forwardedArgs, withTauri } = {}) {
  const args = Array.isArray(forwardedArgs) ? forwardedArgs.map((arg) => String(arg ?? '')).filter(Boolean) : [];
  if (!withTauri) {
    return args.length > 0 ? args : ['dev'];
  }

  const childArgs = args.length > 0 ? args : ['dev'];
  if (childArgs.includes('--no-browser')) {
    return childArgs;
  }
  return [...childArgs, '--no-browser'];
}

export function shouldStartTauriPane(forwardedArgs) {
  if (!isTuiStartLikeForwardedArgs(forwardedArgs)) {
    return false;
  }

  const args = Array.isArray(forwardedArgs) ? forwardedArgs : [];
  const first = String(args[0] ?? '').trim();
  if (first === 'dev') return true;

  const stackIdx = args.indexOf('stack');
  if (stackIdx < 0) return false;
  return String(args[stackIdx + 1] ?? '').trim() === 'dev';
}

export function resolveTauriPaneCwd({ rootDir, env = process.env } = {}) {
  return getRepoDir(rootDir, env);
}

export function resolveTauriPaneInvocation({ rootDir, env = process.env } = {}) {
  const cwd = resolveTauriPaneCwd({ rootDir, env });
  return {
    command: process.execPath,
    args: [join(cwd, 'apps', 'stack', 'scripts', 'tauri_dev.mjs')],
    cwd,
  };
}

export function buildTauriPaneEnv({ env = process.env, resolveUserHomeDir } = {}) {
  return {
    ...buildTauriRuntimeEnv({ env, resolveUserHomeDir }),
    HAPPIER_STACK_TUI: '1',
    COREPACK_ENABLE_AUTO_PIN: '0',
    COREPACK_ENABLE_STRICT: '0',
  };
}

export function resolveTauriPaneSpawnConfig({ rootDir, env = process.env, resolveUserHomeDir } = {}) {
  const tauriEnv = buildTauriPaneEnv({ env, resolveUserHomeDir });
  return {
    invocation: resolveTauriPaneInvocation({ rootDir, env: tauriEnv }),
    env: tauriEnv,
  };
}
