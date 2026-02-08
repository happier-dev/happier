import { vi } from 'vitest'

export type EnvValues = Record<string, string | undefined>

export const START_SERVER_ENV_KEYS = [
  'SERVER_ROLE',
  'REDIS_URL',
  'DATABASE_URL',
  'HAPPY_SERVER_FLAVOR',
  'HAPPIER_SERVER_FLAVOR',
  'HAPPY_DB_PROVIDER',
  'HAPPIER_DB_PROVIDER',
  'HAPPY_FILES_BACKEND',
  'HAPPIER_FILES_BACKEND',
  'HAPPY_SOCKET_ADAPTER',
  'HAPPIER_SOCKET_ADAPTER',
  'HAPPY_SOCKET_REDIS_ADAPTER',
  'HAPPIER_SOCKET_REDIS_ADAPTER',
  'HAPPY_SERVER_LIGHT_DATA_DIR',
  'HAPPIER_SERVER_LIGHT_DATA_DIR',
  'VOICE_LEASE_CLEANUP',
] as const

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

export function snapshotStartServerEnv(): EnvValues {
  return snapshotEnvValues(START_SERVER_ENV_KEYS)
}

export function installStartServerCommonWiringMocks(): void {
  vi.mock('@/app/api/api', () => ({ startApi: vi.fn(async () => {}) }))
  vi.mock('@/app/monitoring/metrics', () => ({ startMetricsServer: vi.fn(async () => {}) }))
  vi.mock('@/app/monitoring/metrics2', () => ({ startDatabaseMetricsUpdater: vi.fn(() => {}) }))
  vi.mock('@/app/auth/auth', () => ({ auth: { init: vi.fn(async () => {}), verifyToken: vi.fn() } }))
  vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: { enableDbFlush: vi.fn(), shutdown: vi.fn() },
  }))
  vi.mock('@/app/presence/timeout', () => ({ startTimeout: vi.fn(() => {}) }))
  vi.mock('@/flavors/light/env', () => ({
    applyLightDefaultEnv: vi.fn(),
    ensureHandyMasterSecret: vi.fn(async () => {}),
  }))
  vi.mock('@/modules/encrypt', () => ({ initEncrypt: vi.fn(async () => {}) }))
  vi.mock('@/app/auth/providers/github/webhooks', () => ({ initGithub: vi.fn(async () => {}) }))
  vi.mock('@/storage/files', () => ({
    loadFiles: vi.fn(async () => {}),
    initFilesLocalFromEnv: vi.fn(() => {}),
    initFilesS3FromEnv: vi.fn(() => {}),
  }))
  vi.mock('@/utils/log', () => ({ log: vi.fn() }))
  vi.mock('@/app/changes/accountChangeCleanup', () => ({
    startAccountChangeCleanupFromEnv: vi.fn(() => null),
  }))
  vi.mock('@/app/presence/presenceMode', () => ({
    shouldConsumePresenceFromRedis: vi.fn(() => false),
    shouldEnableLocalPresenceDbFlush: vi.fn(() => false),
  }))
  vi.mock('@/app/presence/presenceRedisQueue', () => ({
    startPresenceRedisWorker: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
  }))
}
