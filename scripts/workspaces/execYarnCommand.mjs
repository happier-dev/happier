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
  const corepackCommand = platform === 'win32' ? 'corepack.cmd' : 'corepack';

  if (options.preferCorepack === true) {
    return {
      command: corepackCommand,
      args: ['yarn'],
    };
  }

  if (!normalizedNpmExecPath) {
    return { command: corepackCommand, args: ['yarn'] };
  }

  const isNpmCliPath = /(^|[\\/])npm-cli\.js$/i.test(normalizedNpmExecPath);
  if (isNpmCliPath) {
    return { command: corepackCommand, args: ['yarn'] };
  }

  return { command: processExecPath, args: [normalizedNpmExecPath] };
}

export function resolveYarnCommandInvocation(args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const invocation = resolveYarnInvocation(options.npmExecPath, {
    platform,
    processExecPath: options.processExecPath,
    preferCorepack: options.preferCorepack,
  });
  const commandArgs = [...invocation.args, ...args];

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(invocation.command)) {
    return buildWindowsCmdShimInvocation(invocation.command, commandArgs, { comspec: options.comspec });
  }

  return { command: invocation.command, args: commandArgs };
}

export function resolveNpmCommandInvocation(args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const npmExecPath = String(options.npmExecPath ?? '').trim();
  const processExecPath = String(options.processExecPath ?? process.execPath).trim();
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';

  if (npmExecPath && /(^|[\\/])npm-cli\.js$/i.test(npmExecPath)) {
    return {
      command: processExecPath,
      args: [npmExecPath, ...args],
    };
  }

  if (platform === 'win32') {
    return buildWindowsCmdShimInvocation(npmCommand, args, { comspec: options.comspec });
  }

  return {
    command: npmCommand,
    args: [...args],
  };
}

export function execYarn(args, options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync;
  const {
    execFileSync: _execFileSync,
    npmExecPath,
    platform: _platform,
    comspec,
    processExecPath: _processExecPath,
    preferCorepack,
    ...childOptions
  } = options;
  const invocation = resolveYarnCommandInvocation(args, {
    npmExecPath,
    platform: options.platform,
    processExecPath: options.processExecPath,
    preferCorepack,
    comspec,
  });

  return execFileSync(invocation.command, invocation.args, {
    ...childOptions,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}
