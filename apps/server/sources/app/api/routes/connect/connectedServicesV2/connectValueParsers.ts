export function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
