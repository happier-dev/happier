const KNOWN_LAN_DOMAIN_SUFFIXES = ['.local', '.lan', '.localdomain'] as const;

export function normalizeMachineHost(value: string | null | undefined): string {
  const trimmed = String(value ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  for (const suffix of KNOWN_LAN_DOMAIN_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }
  return trimmed;
}

export function compareMachineHosts(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeMachineHost(a);
  const right = normalizeMachineHost(b);
  if (!left || !right) return false;
  return left === right;
}
