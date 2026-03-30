import { accessSync, constants, existsSync, statSync } from 'node:fs';

import { commandExistsInPath } from '@/daemon/service/commandExistsInPath';
import { resolveProviderCliCommand } from '@/runtime/managedTools/providerCliResolution';

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

export function probeCodexAppServerExecutionRunAvailability(opts: Readonly<{
  env?: NodeJS.ProcessEnv;
}> = {}): boolean {
  const env = opts.env ?? process.env;
  const overrideCommand = readOverrideCommand(env);
  if (overrideCommand) {
    return looksLikeFilePath(overrideCommand)
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
  }
  return resolveProviderCliCommand('codex', { processEnv: env }) !== null;
}
