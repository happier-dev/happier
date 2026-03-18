type MachineFileBrowserConfig = Readonly<{
  maxEntries: number
  statConcurrency: number
}>

function parsePositiveIntEnv(
  rawValue: string | undefined,
  fallback: number,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const parsedValue = Number.parseInt(String(rawValue ?? '').trim(), 10)
  if (!Number.isFinite(parsedValue)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, parsedValue))
}

export function resolveMachineFileBrowserConfig(env: NodeJS.ProcessEnv = process.env): MachineFileBrowserConfig {
  return {
    maxEntries: parsePositiveIntEnv(env.HAPPIER_MACHINE_PATH_BROWSER_MAX_ENTRIES, 200, { min: 1, max: 5_000 }),
    statConcurrency: parsePositiveIntEnv(env.HAPPIER_MACHINE_PATH_BROWSER_STAT_CONCURRENCY, 16, { min: 1, max: 128 }),
  }
}
