import { windowsSystemToolCommand } from '@happier-dev/cli-common/process';

import { serializeWindowsCommandLine } from './windowsCommandLine';

type PowerShellInvocation = {
  command: string;
  args: string[];
};

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function toPowerShellStringLiteral(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`;
}

function escapeWindowsTerminalCommandSeparator(
  value: string,
): string {
  return value.replaceAll(';', '\\;');
}

export function buildWindowsTerminalArgumentLine(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  windowId: string;
  title: string;
}): string {
  const argsArray = [
    '-w',
    params.windowId,
    'new-tab',
    '--title',
    params.title,
    '--startingDirectory',
    params.workingDirectory,
    params.filePath,
    ...params.args,
  ].map(escapeWindowsTerminalCommandSeparator);
  return serializeWindowsCommandLine(argsArray);
}

/**
 * The dispatcher runs `wt.exe` in a PowerShell child, so without an exact path the executable is
 * chosen by that child's `PATH` — a different search from the one the daemon used to decide
 * Windows Terminal was available, and a different one again from the `PATH` the later inventory
 * and cancellation steps see. `terminalExecutablePath` carries the executable the launch owner
 * already resolved so all four steps name one binary.
 */
export function buildPowerShellStartWindowsTerminalInvocation(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  windowId: string;
  title: string;
  terminalExecutablePath: string;
  env?: NodeJS.ProcessEnv;
}): PowerShellInvocation {
  const argumentLine =
    buildWindowsTerminalArgumentLine(params);
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$p = Start-Process -FilePath ${toPowerShellStringLiteral(params.terminalExecutablePath)} -ArgumentList ${toPowerShellStringLiteral(argumentLine)} -WorkingDirectory ${toPowerShellStringLiteral(params.workingDirectory)} -PassThru;`,
    'Write-Output $p.Id;',
  ].join(' ');

  return {
    command: windowsSystemToolCommand('powershell.exe', params.env),
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}
