export function resolveAuthMethodFlag(args: string[]): 'web' | 'mobile' | null {
  const idx = args.findIndex((a) => a === '--method');
  if (idx !== -1) {
    const value = (args[idx + 1] ?? '').toString().trim().toLowerCase();
    if (!value) throw new Error('Missing value for --method (expected: web|mobile)');
    if (value === 'web' || value === 'mobile') return value;
    throw new Error(`Invalid --method value: ${value} (expected: web|mobile)`);
  }

  const withEq = args.find((a) => a.startsWith('--method='));
  if (withEq) {
    const value = withEq.slice('--method='.length).trim().toLowerCase();
    if (!value) throw new Error('Missing value for --method (expected: web|mobile)');
    if (value === 'web' || value === 'mobile') return value;
    throw new Error(`Invalid --method value: ${value} (expected: web|mobile)`);
  }

  return null;
}
