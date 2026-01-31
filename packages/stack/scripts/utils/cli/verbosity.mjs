export function getVerbosityLevel(env = process.env) {
  const raw = (env.HAPPIER_STACK_VERBOSE ?? '').toString().trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(3, Math.floor(n)));
}

export function isVerbose(env = process.env) {
  return getVerbosityLevel(env) > 0;
}
