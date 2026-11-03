import { vi } from 'vitest'

export { applyEnvValues, restoreEnvValues, snapshotEnvValues, type EnvValues } from './env'

export const startVoiceProviderIdentityBackfillWorkerMock = vi.fn((_params: unknown) => null)
export const startEnterpriseIdentitySyncWorkerMock = vi.fn(
  (_params: unknown): Readonly<{ stop: () => Promise<void>; nudge: () => void }> | null => null,
)
export const startPluginWebhookCredentialRetirementWorkerMock = vi.fn(
  (_params: unknown): Readonly<{ stop: () => void }> | null => null,
)

export function installStartServerCommonWiringMocks(): void {
  // startApi returns the listening Fastify instance; the managed Home Iroh
  // composition derives the actual bound port from its server address.
  vi.mock('@/app/api/api', () => ({
    startApi: vi.fn(async () => ({
      server: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 3005 }) },
    })),
  }))
  vi.mock('@/app/monitoring/metrics', () => ({ startMetricsServer: vi.fn(async () => true) }))
  vi.mock('@/app/monitoring/metrics/index', async () => ({
    ...await vi.importActual<typeof import('@/app/monitoring/metrics/index')>('@/app/monitoring/metrics/index'),
    startDatabaseMetricsUpdater: vi.fn(() => {}),
    setSocketAdapterModeInfo: vi.fn(() => {}),
  }))
  vi.mock('@/app/auth/auth', () => ({ auth: { init: vi.fn(async () => {}), verifyToken: vi.fn() } }))
  vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: { shutdown: vi.fn() },
  }))
  vi.mock('@/flavors/light/env', async () => {
    const actual = await vi.importActual<typeof import('@/flavors/light/env')>('@/flavors/light/env')
    return {
      ...actual,
      ensureHandyMasterSecret: vi.fn(async () => {}),
    }
  })
  vi.mock('@/modules/encrypt', () => ({ initEncrypt: vi.fn(async () => {}) }))
  vi.mock('@/storage/blob/files', () => ({
    loadFiles: vi.fn(async () => {}),
    initFilesLocalFromEnv: vi.fn(() => {}),
    initFilesS3FromEnv: vi.fn(() => {}),
  }))
  vi.mock('@/utils/logging/log', async () => ({
    ...await vi.importActual<typeof import('@/utils/logging/log')>('@/utils/logging/log'),
    log: vi.fn(),
  }))
  vi.mock('@/app/retention/runtime/startRetentionWorker', () => ({
    startRetentionWorker: vi.fn(() => null),
  }))
  vi.mock('@/app/plugins/webhooks/credentialRetirementWorker', () => ({
    startPluginWebhookCredentialRetirementWorker: (params: unknown) => (
      startPluginWebhookCredentialRetirementWorkerMock(params)
    ),
  }))
  vi.mock('@/app/voice/providerIdentityBackfill/worker', () => ({
    startVoiceProviderIdentityBackfillWorker: (params: unknown) => startVoiceProviderIdentityBackfillWorkerMock(params),
  }))
  vi.mock('@/app/teams/directory/runtime/worker', () => ({
    startEnterpriseIdentitySyncWorker: (params: unknown) => startEnterpriseIdentitySyncWorkerMock(params),
  }))
  vi.mock('@/app/presence/presenceMode', () => ({
    shouldConsumePresenceFromRedis: vi.fn(() => false),
  }))
  vi.mock('@/app/presence/presenceRedisQueue', () => ({
    startPresenceRedisWorker: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
  }))
  vi.mock('@/app/integrations/publicUrl/publicServerUrlInference', () => ({
    resolveInferredPublicServerAccess: vi.fn(async () => ({ inferred: null, relayAccess: null })),
    resolveInferredPublicServerUrl: vi.fn(async () => null),
    peekInferredPublicServerUrl: vi.fn(() => null),
    readInferredPublicServerAccess: vi.fn(() => null),
  }))
}

type StartServerDbProviderReader = (env: unknown, fallback: unknown) => unknown

type StartServerDbMockOptions = Readonly<{
  getDbProviderFromEnv?: StartServerDbProviderReader
}>

export function createStartServerDbMocks(options: StartServerDbMockOptions = {}) {
  const dbConnect = vi.fn()
  const dbDisconnect = vi.fn()
  const dbQueryRawUnsafe = vi.fn()
  const initDbPostgres = vi.fn()
  const initDbPglite = vi.fn()
  const initDbMysql = vi.fn()
  const initDbSqlite = vi.fn()
  const sqliteMaintenanceClientConnect = vi.fn()
  const sqliteMaintenanceClientDisconnect = vi.fn()
  const sqliteMaintenanceClientQueryRawUnsafe = vi.fn()
  const sqliteMaintenanceClient = {
    $connect: (...args: any[]) => sqliteMaintenanceClientConnect(...args),
    $disconnect: (...args: any[]) => sqliteMaintenanceClientDisconnect(...args),
    $queryRawUnsafe: (...args: any[]) => sqliteMaintenanceClientQueryRawUnsafe(...args),
  }
  const createDbSqliteMaintenanceClient = vi.fn()
  const applySqliteRuntimePragmas = vi.fn()
  const shutdownDbPglite = vi.fn()
  const getDbProviderFromEnv = vi.fn<StartServerDbProviderReader>()
  const simpleCacheFindUnique = vi.fn()
  const simpleCacheCreate = vi.fn()
  const simpleCacheUpsert = vi.fn()
  const accountCount = vi.fn()
  // Storage boundary for startup's real, page-transactional turn conversion.
  const sessionTurnFindMany = vi.fn<(...args: unknown[]) => Promise<unknown[]>>()
  const sessionTurnUpdateMany = vi.fn<(...args: unknown[]) => Promise<{ count: number }>>()
  const transactionClient = {
    sessionTurn: { findMany: sessionTurnFindMany, updateMany: sessionTurnUpdateMany },
    $queryRaw: vi.fn(async () => [{ statement_timeout: '0' }]),
    $executeRawUnsafe: vi.fn(async () => 0),
  }
  const dbTransaction = async <T>(callback: (tx: typeof transactionClient) => Promise<T>) => callback(transactionClient)
  const isPrismaErrorCode = vi.fn((error: unknown, code: string) => {
    return !!error && typeof error === 'object' && (error as { code?: unknown }).code === code
  })

  const reset = () => {
    dbConnect.mockReset().mockImplementation(async () => {})
    dbDisconnect.mockReset().mockImplementation(async () => {})
    dbQueryRawUnsafe.mockReset().mockResolvedValue([{
      migration_name: '20260810120000_contract_session_system_record_addresses',
    }])
    initDbPostgres.mockReset().mockImplementation(() => {})
    initDbPglite.mockReset().mockImplementation(async () => {})
    initDbMysql.mockReset().mockImplementation(async () => {})
    initDbSqlite.mockReset().mockImplementation(async () => {})
    sqliteMaintenanceClientConnect.mockReset().mockImplementation(async () => {})
    sqliteMaintenanceClientDisconnect.mockReset().mockImplementation(async () => {})
    sqliteMaintenanceClientQueryRawUnsafe.mockReset().mockImplementation(async () => [])
    createDbSqliteMaintenanceClient.mockReset().mockImplementation(async () => sqliteMaintenanceClient)
    applySqliteRuntimePragmas.mockReset().mockImplementation(async () => {})
    shutdownDbPglite.mockReset().mockImplementation(async () => {})
    getDbProviderFromEnv.mockReset().mockImplementation(options.getDbProviderFromEnv ?? ((_env, fallback) => fallback))
    simpleCacheFindUnique.mockReset().mockResolvedValue(null)
    simpleCacheCreate.mockReset().mockImplementation(async (args: any) => ({ value: args?.data?.value }))
    simpleCacheUpsert.mockReset().mockImplementation(async (args: any) => ({ value: args?.create?.value ?? args?.update?.value }))
    accountCount.mockReset().mockResolvedValue(0)
    sessionTurnFindMany.mockReset().mockResolvedValue([])
    sessionTurnUpdateMany.mockReset().mockResolvedValue({ count: 0 })
    isPrismaErrorCode.mockClear()
  }

  reset()

  return {
    module: {
      db: {
        $connect: (...args: any[]) => dbConnect(...args),
        $disconnect: (...args: any[]) => dbDisconnect(...args),
        $queryRawUnsafe: (...args: any[]) => dbQueryRawUnsafe(...args),
        $transaction: dbTransaction,
        simpleCache: {
          findUnique: (...args: any[]) => simpleCacheFindUnique(...args),
          create: (...args: any[]) => simpleCacheCreate(...args),
          upsert: (...args: any[]) => simpleCacheUpsert(...args),
        },
        account: {
          count: (...args: any[]) => accountCount(...args),
        },
        // Startup's real presence owners seed an empty persisted census.
        machine: { findMany: vi.fn(async () => []) },
        session: { findFirst: vi.fn(async () => null) },
        // Most startup fixtures describe an unconfigured Home; keep its real overlay path.
        homeSettings: { findUnique: vi.fn(async () => null) },
        homeGovernancePolicy: { findUnique: vi.fn(async () => null) },
      },
      getDbProviderFromEnv: (...args: Parameters<StartServerDbProviderReader>) => getDbProviderFromEnv(...args),
      initDbPostgres: (...args: any[]) => initDbPostgres(...args),
      initDbPglite: (...args: any[]) => initDbPglite(...args),
      initDbMysql: (...args: any[]) => initDbMysql(...args),
      initDbSqlite: (...args: any[]) => initDbSqlite(...args),
      createDbSqliteMaintenanceClient: (...args: any[]) => createDbSqliteMaintenanceClient(...args),
      applySqliteRuntimePragmas: (...args: any[]) => applySqliteRuntimePragmas(...args),
      shutdownDbPglite: (...args: any[]) => shutdownDbPglite(...args),
      isPrismaErrorCode: (...args: [unknown, string]) => isPrismaErrorCode(...args),
    },
    dbConnect,
    sessionTurnFindMany,
    sessionTurnUpdateMany,
    dbDisconnect,
    dbQueryRawUnsafe,
    getDbProviderFromEnv,
    simpleCacheFindUnique,
    simpleCacheCreate,
    simpleCacheUpsert,
    accountCount,
    initDbPostgres,
    initDbPglite,
    initDbMysql,
    initDbSqlite,
    sqliteMaintenanceClient,
    sqliteMaintenanceClientConnect,
    sqliteMaintenanceClientDisconnect,
    sqliteMaintenanceClientQueryRawUnsafe,
    createDbSqliteMaintenanceClient,
    applySqliteRuntimePragmas,
    shutdownDbPglite,
    isPrismaErrorCode,
    reset,
  }
}

export function installStartServerDbModuleMock(
    dbMocks: ReturnType<typeof createStartServerDbMocks>,
): void {
    vi.doMock("@/storage/db", () => ({ ...dbMocks.module }))
}
