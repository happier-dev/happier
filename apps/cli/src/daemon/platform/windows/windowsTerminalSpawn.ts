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

export function buildPowerShellStartWindowsTerminalInvocation(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  windowId: string;
  title: string;
}): PowerShellInvocation {
  const argumentLine =
    buildWindowsTerminalArgumentLine(params);
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$p = Start-Process -FilePath 'wt.exe' -ArgumentList ${toPowerShellStringLiteral(argumentLine)} -WorkingDirectory ${toPowerShellStringLiteral(params.workingDirectory)} -PassThru;`,
    'Write-Output $p.Id;',
  ].join(' ');

  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}
