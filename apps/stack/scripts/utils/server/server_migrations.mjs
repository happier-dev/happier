import { pmExecBin } from '../proc/pm.mjs';
import { normalizeDbProvider } from './effective_db_provider.mjs';

export async function applyServerMigrations(
  { serverDir, env, quiet = false, dbProvider },
  { pmExecBinImpl = pmExecBin } = {},
) {
  const effectiveDbProvider = normalizeDbProvider(dbProvider);
  if (!effectiveDbProvider) throw new Error(`Unsupported DB provider: ${String(dbProvider ?? '')}`);
  const script = effectiveDbProvider === 'mysql'
    ? 'migrate:mysql:deploy'
    : effectiveDbProvider === 'sqlite'
      ? 'migrate:sqlite:deploy'
      : effectiveDbProvider === 'pglite'
        ? 'migrate:light:deploy'
        : null;
  if (script) {
    await pmExecBinImpl({ dir: serverDir, bin: script, args: [], env, quiet });
    return;
  }
  await pmExecBinImpl({ dir: serverDir, bin: 'prisma', args: ['migrate', 'deploy'], env, quiet });
}
