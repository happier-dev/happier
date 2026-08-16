function assertRepresentablePowerShellValue(value: string): void {
  if (value.includes('\0')) {
    throw new TypeError('PowerShell command values must not contain NUL');
  }
}

export function toPowerShellStringLiteral(value: string): string {
  assertRepresentablePowerShellValue(value);
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildPowerShellCommand(args: readonly string[]): string {
  if (args.length === 0) {
    throw new TypeError('PowerShell command requires an executable');
  }
  return `& ${args.map((arg) => toPowerShellStringLiteral(String(arg))).join(' ')}`;
}

export function buildEncodedPowerShellCommand(args: readonly string[]): string {
  const script = buildPowerShellCommand(args);
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
}
