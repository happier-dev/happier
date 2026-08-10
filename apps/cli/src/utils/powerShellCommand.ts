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
