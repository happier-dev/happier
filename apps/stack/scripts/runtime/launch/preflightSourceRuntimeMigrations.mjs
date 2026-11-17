import { applyServerLightEnvDefaults } from '../../utils/server/apply_server_light_env_defaults.mjs';
import { applyRuntimeServerDatabaseEnv } from '../../utils/server/apply_runtime_server_database_env.mjs';
import { killProcessTree } from '../../utils/proc/proc.mjs';
import { resolveServerRuntimeLaunchSpec } from './resolveServerRuntimeLaunchSpec.mjs';
import { runServerRuntimeMigration } from './runServerRuntimeMigration.mjs';
import { recordSourceReloadRefusal } from '../shared/source_reload_refusal.mjs';
import { applyHappyServerMigrations } from '../../utils/server/infra/happy_server_infra.mjs';
import { assertSharedDatabaseMigrationsApplied } from '../../utils/server/shared_database_migration_gate.mjs';

/** The reload owner invokes this on the server host before retiring its incumbent.
 * Shared-source environment projection disables deploy; the existing ledger owner
 * still checks every required migration before that consumer can activate. */
export async function preflightSourceRuntimeMigrations({ server, env, stackBaseDir, signal, currentServerDir }) {
  if (!server) return;
  signal?.throwIfAborted();
  // PGlite's incumbent owns its exclusive data-directory lock. Its existing
  // exclusive reload path deploys only after that process releases the lock.
  if (server.dbProvider === 'pglite') return;
  // An explicit dev restart can retain executable code while FINAL migrations
  // have advanced. Deploy the current checkout, never the older bundle catalog.
  const retainedRestart = server.lastGreen && currentServerDir;
  const serverEnv = { ...env, ...(retainedRestart ? {} : server.env) };
  if (server.serverComponent === 'happier-server-light') {
    applyServerLightEnvDefaults({ baseEnv: serverEnv, serverEnv, baseDir: stackBaseDir });
  }
  applyRuntimeServerDatabaseEnv({ env: serverEnv, serverDir: retainedRestart ? currentServerDir : server.serverDir });
  if (!String(serverEnv.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ?? '').trim()) {
    // An explicit reload deploys its own current source before activation, even
    // when ordinary server-start auto migration is disabled.
    serverEnv.RUN_MIGRATIONS = '1';
    serverEnv.HAPPIER_STACK_PRISMA_MIGRATE = '1';
    serverEnv.HAPPIER_SQLITE_AUTO_MIGRATE = '1';
    serverEnv.HAPPIER_STACK_MIGRATE_MODE = 'always';
  }
  const serverLaunchSpec = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch: server,
    migrationsEnabled: true });
  const children = [];
  const cancel = () => {
    for (const child of children) void killProcessTree(child, 'SIGTERM').catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (retainedRestart) {
      const shared = await assertSharedDatabaseMigrationsApplied({ serverDir: currentServerDir, env: serverEnv });
      if (!shared) await applyHappyServerMigrations({ serverDir: currentServerDir, env: serverEnv });
    } else {
      await runServerRuntimeMigration({ serverLaunchSpec, sourceServerDir: currentServerDir, env: serverEnv, children,
        isCancellationRequested: () => signal?.aborted === true });
    }
    signal?.throwIfAborted();
  } catch (error) {
    await recordSourceReloadRefusal({ stackBaseDir, error, env: serverEnv });
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
