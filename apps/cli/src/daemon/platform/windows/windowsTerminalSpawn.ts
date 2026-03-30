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

export function buildPowerShellStartWindowsTerminalInvocation(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  windowId: string;
  title: string;
}): PowerShellInvocation {
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
  ];
  const argsArrayLiteral = `@(${argsArray.map((arg) => toPowerShellStringLiteral(arg)).join(', ')})`;
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$p = Start-Process -FilePath 'wt.exe' -ArgumentList ${argsArrayLiteral} -WorkingDirectory ${toPowerShellStringLiteral(params.workingDirectory)} -PassThru;`,
    'Write-Output $p.Id;',
  ].join(' ');

  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}
