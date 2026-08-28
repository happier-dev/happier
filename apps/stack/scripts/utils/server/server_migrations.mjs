import { pmExecBin } from '../proc/pm.mjs';
import { normalizeDbProvider } from './effective_db_provider.mjs';

export async function applyServerMigrations(
  { serverDir, env, quiet = false, dbProvider },
  { pmExecBinImpl = pmExecBin } = {},
) {
  const effectiveDbProvider = normalizeDbProvider(dbProvider);
  if (!effectiveDbProvider) throw new Error(`Unsupported DB provider: ${String(dbProvider ?? '')}`);
  await pmExecBinImpl({
    dir: serverDir,
    bin: 'migrate:deploy',
    args: [],
    env: { ...env, HAPPIER_DB_PROVIDER: effectiveDbProvider },
    quiet,
  });
}
