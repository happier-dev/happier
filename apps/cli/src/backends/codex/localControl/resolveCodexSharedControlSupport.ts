import { execFileSync } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { isVersionAtLeast, parseCodexVersionInfo } from '../mcp/version';
import { CODEX_APP_SERVER_OVERRIDE_ENV_KEYS, resolveCodexCliInvocation } from '../utils/resolveCodexCliInvocation';

const SHARED_CONTROL_MIN_VERSION_UNIX = { major: 0, minor: 131, patch: 0 } as const;

type Dependencies = Readonly<{
  resolveInvocation: typeof resolveCodexCliInvocation;
  execute: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => string;
}>;

export async function resolveCodexSharedControlSupport(params: Readonly<{
  cwd: string;
  processEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  dependencies?: Partial<Dependencies>;
}>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: 'unsupported-version' }>> {
  const processEnv = params.processEnv ?? process.env;
  const resolveInvocation = params.dependencies?.resolveInvocation ?? resolveCodexCliInvocation;
  const execute = params.dependencies?.execute ?? ((command, args, env) => execFileSync(command, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
  }));
  try {
    const resolved = await resolveInvocation({
      args: ['--version'],
      cwd: params.cwd,
      processEnv,
      overrideEnvVarKeys: CODEX_APP_SERVER_OVERRIDE_ENV_KEYS,
      targetLabel: 'Codex CLI',
    });
    const invocation = resolveWindowsCommandInvocation({
      command: resolved.command,
      args: resolved.args,
      env: processEnv,
      resolveCommandOnPath: true,
    });
    const version = parseCodexVersionInfo(execute(invocation.command, invocation.args, processEnv));
    // Codex 0.154 added protected Windows AF_UNIX sockets, but Node's IPC path
    // transport connects Windows named pipes only. Keep Windows on the existing
    // exclusive local-control path until Happier owns an AF_UNIX-capable bridge.
    if ((params.platform ?? process.platform) === 'win32') {
      return { ok: false, reason: 'unsupported-version' };
    }
    return isVersionAtLeast(version, SHARED_CONTROL_MIN_VERSION_UNIX)
      ? { ok: true }
      : { ok: false, reason: 'unsupported-version' };
  } catch {
    return { ok: false, reason: 'unsupported-version' };
  }
}
