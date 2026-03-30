export function readRepeatedFlagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== flag) continue;
    const next = argv[i + 1];
    if (typeof next === 'string' && next.trim()) {
      values.push(next.trim());
      i += 1;
    }
  }
  return values;
}
