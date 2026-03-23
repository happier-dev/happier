export function readStartedByArg(args: ReadonlyArray<string>): Readonly<{
  present: boolean;
  value: 'daemon' | 'terminal' | null;
}> {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--started-by') {
      const next = args[index + 1];
      if (typeof next !== 'string') return { present: true, value: null };
      const normalized = next.trim();
      if (normalized === 'daemon' || normalized === 'terminal') {
        return { present: true, value: normalized };
      }
      return { present: true, value: null };
    }
    if (arg.startsWith('--started-by=')) {
      const normalized = arg.slice('--started-by='.length).trim();
      if (normalized === 'daemon' || normalized === 'terminal') {
        return { present: true, value: normalized };
      }
      return { present: true, value: null };
    }
  }
  return { present: false, value: null };
}
