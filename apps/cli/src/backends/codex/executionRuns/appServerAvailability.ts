import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { commandExistsInPath } from '@/daemon/service/commandExistsInPath';
import { resolveProviderCliCommand } from '@/packagedRuntime/managedTools/providerCliResolution';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

const CODEX_APP_SERVER_OVERRIDE_KEYS = [
  'HAPPIER_CODEX_APP_SERVER_BIN',
  'HAPPIER_CODEX_TUI_BIN',
  'HAPPY_CODEX_TUI_BIN',
] as const;

function readOverrideCommand(env: NodeJS.ProcessEnv): string | null {
  for (const key of CODEX_APP_SERVER_OVERRIDE_KEYS) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (value) return value;
  }
  return null;
}

function looksLikeFilePath(command: string): boolean {
  return command.includes('/') || command.includes('\\') || command.startsWith('.');
}

function readProbeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(String(env.HAPPIER_CODEX_APP_SERVER_PROBE_TIMEOUT_MS ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 1_500;
}

function supportsAppServerSubcommand(command: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const invocation = resolveWindowsCommandInvocation({
      command,
      args: ['app-server', '--help'],
      resolveCommandOnPath: true,
    });
    const result = spawnSync(invocation.command, invocation.args, {
      env,
      timeout: readProbeTimeoutMs(env),
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: 'ignore',
    });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

export function appServerAvailability(opts: Readonly<{
  env?: NodeJS.ProcessEnv;
}> = {}): boolean {
  const env = opts.env ?? process.env;
  const overrideCommand = readOverrideCommand(env);
  if (overrideCommand) {
    const exists = looksLikeFilePath(overrideCommand)
      ? (() => {
          try {
            if (!existsSync(overrideCommand)) return false;
            const stats = statSync(overrideCommand);
            if (!stats.isFile()) return false;
            accessSync(overrideCommand, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        })()
      : commandExistsInPath({
          cmd: overrideCommand,
          envPath: env.PATH,
          platform: process.platform,
          pathext: env.PATHEXT,
        });
    return exists && supportsAppServerSubcommand(overrideCommand, env);
  }
  const resolved = resolveProviderCliCommand('codex', { processEnv: env });
  return resolved !== null && supportsAppServerSubcommand(resolved.command, env);
}
