export function resolveIntEnvWithBounds(
  envVar: string,
  opts: Readonly<{ min?: number; max?: number; default: number }>,
): number {
  const raw = String(process.env[envVar] ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  const min = opts.min ?? 1;
  if (!Number.isFinite(parsed) || parsed < min) return opts.default;
  return opts.max != null ? Math.min(parsed, opts.max) : parsed;
}
