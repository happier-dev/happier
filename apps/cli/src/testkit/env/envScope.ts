import { snapshotEnvValues, applyEnvValues } from './envSnapshot'

function applyEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

export function createEnvKeyScope(keys: readonly string[]): {
  patch: (values: Readonly<Record<string, string | undefined>>) => void
  restore: () => void
} {
  const baseline = snapshotEnvValues(keys)

  return {
    patch(values: Readonly<Record<string, string | undefined>>): void {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(values, key)) continue
        applyEnvValue(key, values[key])
      }
    },
    restore(): void {
      applyEnvValues(baseline)
    },
  }
}
