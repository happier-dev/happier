export function resolveIntEnvWithBounds(
  envVar: string,
  opts: Readonly<{ min?: number; max?: number; default: number }>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = String(env[envVar] ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  const min = opts.min ?? 1;
  if (!Number.isFinite(parsed) || parsed < min) return opts.default;
  return opts.max != null ? Math.min(parsed, opts.max) : parsed;
}
