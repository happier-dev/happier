import { toPowerShellStringLiteral } from '@/utils/powerShellCommand';

type PowerShellInvocation = {
  command: string;
  args: string[];
};

export function buildPowerShellStartProcessInvocation(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  postStartDelayMs?: number;
}): PowerShellInvocation {
  const filePathLiteral = toPowerShellStringLiteral(params.filePath);
  const workingDirectoryLiteral = toPowerShellStringLiteral(params.workingDirectory);
  const argsArrayLiteral = `@(${params.args.map((arg) => toPowerShellStringLiteral(arg)).join(', ')})`;
  const postStartDelayMs = Number.isFinite(params.postStartDelayMs) && Number(params.postStartDelayMs) > 0
    ? Math.trunc(Number(params.postStartDelayMs))
    : 0;

  const script = [
    '$ErrorActionPreference = "Stop";',
    `$p = Start-Process -FilePath ${filePathLiteral} -ArgumentList ${argsArrayLiteral} -WorkingDirectory ${workingDirectoryLiteral} -PassThru;`,
    ...(postStartDelayMs > 0 ? [`Start-Sleep -Milliseconds ${postStartDelayMs};`] : []),
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
