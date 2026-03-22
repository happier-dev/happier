type EnvValues = Record<string, string | undefined>

export function applyEnvValues(values: EnvValues): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
}

export function snapshotEnvValues(keys: readonly string[]): EnvValues {
  const snapshot: EnvValues = {}
  for (const key of keys) {
    const value = process.env[key]
    snapshot[key] = value === undefined ? undefined : value
  }
  return snapshot
}

export function restoreEnvValues(snapshot: EnvValues): void {
  applyEnvValues(snapshot)
}

export function snapshotProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

export function restoreProcessEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
}
