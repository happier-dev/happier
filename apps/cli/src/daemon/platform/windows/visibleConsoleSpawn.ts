import { serializeWindowsCommandLine } from './windowsCommandLine';

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
  const argumentLine =
    serializeWindowsCommandLine(params.args);

  const script = [
    '$ErrorActionPreference = "Stop";',
    `$p = Start-Process -FilePath ${filePathLiteral} -ArgumentList ${toPowerShellStringLiteral(argumentLine)} -WorkingDirectory ${workingDirectoryLiteral} -PassThru;`,
    '$startedAtMs = [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();',
    'Write-Output ("HAPPIER_LAUNCH:{0}:{1}" -f $p.Id, $startedAtMs);',
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

export function parsePowerShellStartProcessIdentity(
  stdout: string,
): Readonly<{ pid: number; processStartTimeMs: number }> | null {
  const normalized = stdout.replaceAll('\u0000', '');
  const match = normalized.match(
    /HAPPIER_LAUNCH:(\d+):(\d+)/u,
  );
  if (!match) return null;
  const pid = Number(match[1]);
  const processStartTimeMs = Number(match[2]);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || !Number.isSafeInteger(processStartTimeMs)
    || processStartTimeMs < 0
  ) {
    return null;
  }
  return { pid, processStartTimeMs };
}
