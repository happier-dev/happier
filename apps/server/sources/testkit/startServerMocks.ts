import { vi } from 'vitest'
import { applyEnvValues, restoreEnvValues, snapshotEnvValues, type EnvValues } from './env'

export { applyEnvValues, restoreEnvValues, snapshotEnvValues, type EnvValues } from './env'

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
  'HAPPIER_SERVER_RETENTION__ENABLED',
] as const

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
  vi.mock('@/storage/blob/files', () => ({
    loadFiles: vi.fn(async () => {}),
    initFilesLocalFromEnv: vi.fn(() => {}),
    initFilesS3FromEnv: vi.fn(() => {}),
  }))
  vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }))
  vi.mock('@/app/retention/runtime/startRetentionWorker', () => ({
    startRetentionWorker: vi.fn(() => null),
  }))
  vi.mock('@/app/presence/presenceMode', () => ({
    shouldConsumePresenceFromRedis: vi.fn(() => false),
    shouldEnableLocalPresenceDbFlush: vi.fn(() => false),
  }))
  vi.mock('@/app/presence/presenceRedisQueue', () => ({
    startPresenceRedisWorker: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
  }))
}

type StartServerDbProviderReader = (env: unknown, fallback: unknown) => unknown

type StartServerDbMockOptions = Readonly<{
  getDbProviderFromEnv?: StartServerDbProviderReader
}>

export function createStartServerDbMocks(options: StartServerDbMockOptions = {}) {
  const dbConnect = vi.fn()
  const dbDisconnect = vi.fn()
  const initDbPostgres = vi.fn()
  const initDbPglite = vi.fn()
  const initDbMysql = vi.fn()
  const initDbSqlite = vi.fn()
  const shutdownDbPglite = vi.fn()
  const getDbProviderFromEnv = vi.fn<StartServerDbProviderReader>()

  const reset = () => {
    dbConnect.mockReset().mockImplementation(async () => {})
    dbDisconnect.mockReset().mockImplementation(async () => {})
    initDbPostgres.mockReset().mockImplementation(() => {})
    initDbPglite.mockReset().mockImplementation(async () => {})
    initDbMysql.mockReset().mockImplementation(async () => {})
    initDbSqlite.mockReset().mockImplementation(async () => {})
    shutdownDbPglite.mockReset().mockImplementation(async () => {})
    getDbProviderFromEnv.mockReset().mockImplementation(options.getDbProviderFromEnv ?? ((_env, fallback) => fallback))
  }

  reset()

  return {
    module: {
      db: {
        $connect: (...args: any[]) => dbConnect(...args),
        $disconnect: (...args: any[]) => dbDisconnect(...args),
      },
      getDbProviderFromEnv: (...args: Parameters<StartServerDbProviderReader>) => getDbProviderFromEnv(...args),
      initDbPostgres: (...args: any[]) => initDbPostgres(...args),
      initDbPglite: (...args: any[]) => initDbPglite(...args),
      initDbMysql: (...args: any[]) => initDbMysql(...args),
      initDbSqlite: (...args: any[]) => initDbSqlite(...args),
      shutdownDbPglite: (...args: any[]) => shutdownDbPglite(...args),
    },
    dbConnect,
    dbDisconnect,
    getDbProviderFromEnv,
    initDbPostgres,
    initDbPglite,
    initDbMysql,
    initDbSqlite,
    shutdownDbPglite,
    reset,
    }
}

export function installStartServerDbModuleMock(
    dbMocks: ReturnType<typeof createStartServerDbMocks>,
): void {
    vi.doMock("@/storage/db", () => ({ ...dbMocks.module }))
}
