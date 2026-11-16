export function readStartedByArg(args) {
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

/** The CLI's existing cache lifetime policy, usable before TypeScript loads. */
export function isDaemonHostedCliInvocation(args) {
  return (args[0] === 'daemon' && (args[1] === 'start-sync' || args[1] === 'background-service-worker'))
    || readStartedByArg(args).value === 'daemon';
}
