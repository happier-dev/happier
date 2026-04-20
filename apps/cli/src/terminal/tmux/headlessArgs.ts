export function ensureHeadlessTmuxRemoteStartingModeArgs(argv: string[]): string[] {
  const modeFlagIndexes: number[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--happy-starting-mode') {
      modeFlagIndexes.push(index);
    }
  }

  if (modeFlagIndexes.length === 0) {
    return [...argv, '--happy-starting-mode', 'remote'];
  }

  for (const index of modeFlagIndexes) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for --happy-starting-mode (expected "remote" or "local" for terminal mode)');
    }
    if (value === 'remote') continue;
    if (value === 'local') {
      throw new Error('Headless tmux sessions require remote mode; terminal mode is not supported.');
    }

    // Unknown value: preserve but keep behavior consistent by failing closed.
    throw new Error('Headless tmux sessions require remote mode; terminal mode is not supported.');
  }

  return argv;
}
