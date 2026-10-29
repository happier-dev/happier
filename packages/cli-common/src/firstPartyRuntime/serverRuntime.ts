export {
    DEFAULT_PRISMA_SQLITE_BUSY_TIMEOUT_MS,
    DEFAULT_SERVER_LIGHT_SQLITE_CONNECTION_LIMIT,
    renderPrismaCompatibleSqliteDatabaseUrl,
    resolvePrismaSqliteDatabaseUrlOptionsFromEnv,
    resolveServerLightSqliteDatabaseUrlOptionsFromEnv,
} from './selfHostServerEnv.js';
export type { PrismaSqliteDatabaseUrlOptions } from './selfHostServerEnv.js';
export { readPrismaMigrationLedger, readSqlitePrismaMigrationLedger } from './prismaMigrationLedger.js';
export type { PrismaMigrationLedgerRow } from './prismaMigrationLedger.js';

export {
    PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY,
    PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV,
    RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS,
} from './serverRuntimeContract.js';

export { resolvePersonalHomeRuntimeLayout, resolveHomeIrohEndpointKeyPath } from './personalHome/layout.js';
export type { PersonalHomeRuntimeLayout } from './personalHome/layout.js';
export {
    resolveManagedServerLightPathEnvValue,
    resolvePersonalHomePrivateFilesDir,
} from './personalHome/pathResolvers.js';
export { replacePersonalHomeFileDurably } from './personalHome/durableFile.js';
export {
    assertPersonalHomeBootAdmission,
    PersonalHomeBootAdmissionError,
} from './personalHome/bootAdmission.js';
export type { PersonalHomeBootAdmissionBlockReason } from './personalHome/bootAdmission.js';
export type { PersonalHomeAuthenticatedReadiness } from './personalHome/readiness.js';
export { DEFAULT_PERSONAL_HOME_TEAM_NAME } from './personalHome/personalHomeRuntimeSpec.js';
