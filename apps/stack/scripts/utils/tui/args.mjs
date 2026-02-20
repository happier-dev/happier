export function isTuiHelpRequest(argv) {
  if (!Array.isArray(argv)) return false;
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return true;
  return false;
}

export function normalizeTuiForwardedArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return ['dev'];

  // UX: `hstack tui -- --restart --mobile` is intended to mean "tui dev --restart --mobile".
  // If the user only passed flags, treat them as flags for the default `dev` command.
  const args = argv.filter((a) => String(a ?? '').trim() !== '');
  const allFlags = args.length > 0 && args.every((a) => String(a ?? '').trim().startsWith('-'));
  if (allFlags) return ['dev', ...args];

  return args.length ? args : ['dev'];
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

export function isTuiStartLikeForwardedArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (!args.length) return false;

  const first = String(args[0] ?? '').trim();
  if (first === 'dev' || first === 'start') return true;

  const stackIdx = args.indexOf('stack');
  if (stackIdx < 0) return false;
  const subcmd = String(args[stackIdx + 1] ?? '').trim();
  return subcmd === 'dev' || subcmd === 'start';
}

export function isTuiRestartableForwardedArgs(argv) {
  // Today we only support restart for long-lived stack processes (dev/start).
  // Keeping this as a separate predicate avoids expanding restart support by accident.
  return isTuiStartLikeForwardedArgs(argv);
}
