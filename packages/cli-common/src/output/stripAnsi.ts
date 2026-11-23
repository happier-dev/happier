export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, '');
}
