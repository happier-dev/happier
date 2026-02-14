function psDoubleQuote(s: string): string {
  // PowerShell double-quoted string escape: `"
  return String(s ?? '').replaceAll('`', '``').replaceAll('"', '`"');
}

function psQuoted(s: string): string {
  return `"${psDoubleQuote(s)}"`;
}

export function renderWindowsScheduledTaskWrapperPs1(params: Readonly<{
  workingDirectory?: string;
  programArgs?: readonly string[];
  env?: Record<string, string>;
  stdoutPath?: string;
  stderrPath?: string;
}>): string {
  const wd = String(params.workingDirectory ?? '').trim();
  const args = Array.isArray(params.programArgs) ? params.programArgs.map((a) => String(a ?? '')).filter(Boolean) : [];
  const out = String(params.stdoutPath ?? '').trim();
  const err = String(params.stderrPath ?? '').trim();

  const envLines = Object.entries(params.env ?? {})
    .filter(([k]) => String(k ?? '').trim())
    .map(([k, v]) => `$env:${String(k).trim()} = ${psQuoted(String(v ?? ''))}`)
    .join('\n');

  const cmd = args.length ? `& ${args.map(psQuoted).join(' ')}` : '';
  const redirect = out || err ? ` 1>> ${psQuoted(out)} 2>> ${psQuoted(err)}` : '';

  return [
    '$ErrorActionPreference = "Stop"',
    wd ? `Set-Location -LiteralPath ${psQuoted(wd)}` : '',
    envLines,
    cmd ? `${cmd}${redirect}` : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

