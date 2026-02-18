type PowerShellInvocation = {
  command: string;
  args: string[];
};

function escapePowerShellSingleQuoted(value: string): string {
  // In single-quoted PowerShell strings, literal single-quote is represented by two single-quotes.
  return value.replaceAll("'", "''");
}

function toPowerShellStringLiteral(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`;
}

export function buildPowerShellStartProcessInvocation(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
}): PowerShellInvocation {
  const filePathLiteral = toPowerShellStringLiteral(params.filePath);
  const workingDirectoryLiteral = toPowerShellStringLiteral(params.workingDirectory);
  const argsArrayLiteral = `@(${params.args.map((arg) => toPowerShellStringLiteral(arg)).join(', ')})`;

  const script = [
    '$ErrorActionPreference = "Stop";',
    `$p = Start-Process -FilePath ${filePathLiteral} -ArgumentList ${argsArrayLiteral} -WorkingDirectory ${workingDirectoryLiteral} -PassThru;`,
    'Write-Output $p.Id;',
  ].join(' ');

  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}

export function parsePowerShellStartProcessPid(stdout: string): number | null {
  // PowerShell can emit UTF-16LE-ish output depending on host/codepage. If upstream code decoded the raw bytes
  // as UTF-8, the resulting string often contains NUL separators between characters.
  const trimmed = stdout.replaceAll('\u0000', '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\b(\d+)\b/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : null;
}
