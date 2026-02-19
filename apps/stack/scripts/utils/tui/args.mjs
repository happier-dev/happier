export function isTuiHelpRequest(argv) {
  if (!Array.isArray(argv)) return false;
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return true;
  return false;
}

export function normalizeTuiForwardedArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return ['dev'];
  return argv;
}

export function inferTuiStackName(argv, env = process.env) {
  const args = Array.isArray(argv) ? argv : [];

  const stackIdx = args.indexOf('stack');
  if (stackIdx >= 0) {
    const explicitName = (args[stackIdx + 2] ?? '').toString().trim();
    if (explicitName && !explicitName.startsWith('-')) return explicitName;
  }

  const envStack = (env.HAPPIER_STACK_STACK ?? '').toString().trim();
  return envStack || null;
}
