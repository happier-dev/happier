const RESTART_CONTROL_ONLY_ARGS = new Set(['--json', '--help', '-h']);

export function findRestartControlOnlyArg(args = []) {
  if (!Array.isArray(args)) return null;
  for (const arg of args) {
    const normalized = String(arg ?? '').trim();
    if (RESTART_CONTROL_ONLY_ARGS.has(normalized)) return normalized;
  }
  return null;
}

export function assertRestartHasNoControlOnlyArgs(args = []) {
  const controlArg = findRestartControlOnlyArg(args);
  if (!controlArg) return;

  const error = new Error(
    `[stack] refusing restart: ${controlArg} is a control-only mode and cannot be combined with --restart`,
  );
  error.code = 'ESTACKRESTARTCONTROLARG';
  error.controlArg = controlArg;
  throw error;
}
