import { execFileSync as defaultExecFileSync } from 'node:child_process';

const CMD_META_CHARS_REGEXP = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(arg) {
  return String(arg).replace(CMD_META_CHARS_REGEXP, '^$1');
}

function escapeCmdArgument(arg) {
  let value = String(arg);
  value = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  value = value.replace(/(?=(\\+?)?)\1$/, '$1$1');
  value = `"${value}"`;
  return value.replace(CMD_META_CHARS_REGEXP, '^$1');
}

export function buildWindowsCmdShimInvocation(command, args, options = {}) {
  const comspec =
    String(options.comspec ?? process.env.comspec ?? process.env.ComSpec ?? process.env.COMSPEC ?? '').trim()
    || 'cmd.exe';
  const shellCommand = [escapeCmdCommand(command), ...args.map((arg) => escapeCmdArgument(arg))].join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

export function resolveYarnInvocation(npmExecPath = process.env.npm_execpath, options = {}) {
  const normalizedNpmExecPath = String(npmExecPath ?? '').trim();
  const platform = options.platform ?? process.platform;
  const processExecPath = options.processExecPath ?? process.execPath;
  const yarnCommand = platform === 'win32' ? 'yarn.cmd' : 'yarn';

  if (!normalizedNpmExecPath) {
    return { command: yarnCommand, args: [] };
  }

  const isNpmCliPath = /(^|[\\/])npm-cli\.js$/i.test(normalizedNpmExecPath);
  if (isNpmCliPath) {
    return { command: yarnCommand, args: [] };
  }

  return { command: processExecPath, args: [normalizedNpmExecPath] };
}

export function resolveYarnCommandInvocation(args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const { npmExecPath, platform: _platform, comspec: _comspec, processExecPath: _processExecPath, ..._childOptions } = options;
  const invocation = resolveYarnInvocation(npmExecPath, {
    platform,
    processExecPath: options.processExecPath,
  });
  const commandArgs = [...invocation.args, ...args];

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(invocation.command)) {
    return buildWindowsCmdShimInvocation(invocation.command, commandArgs, { comspec: options.comspec });
  }

  return { command: invocation.command, args: commandArgs };
}

export function execYarn(args, options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync;
  const { execFileSync: _execFileSync, npmExecPath, platform: _platform, comspec, processExecPath: _processExecPath, ...childOptions } = options;
  const invocation = resolveYarnCommandInvocation(args, {
    npmExecPath,
    platform: options.platform,
    processExecPath: options.processExecPath,
    comspec,
  });

  return execFileSync(invocation.command, invocation.args, {
    ...childOptions,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}
