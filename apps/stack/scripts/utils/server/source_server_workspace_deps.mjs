import { ensureWorkspacePackagesBuiltForComponent, pmSpawnScript } from '../proc/pm.mjs';
import { WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { assertSharedDatabaseMigrationsApplied } from './shared_database_migration_gate.mjs';

export async function ensureSourceServerWorkspacePackagesBuilt(
  {
    runtimeBackedStart = false,
    serverDir,
    env = process.env,
    quiet = false,
    startup = false,
    refresh,
    signal,
  } = {},
  { ensureWorkspacePackagesBuiltForComponentImpl = ensureWorkspacePackagesBuiltForComponent } = {},
) {
  if (runtimeBackedStart) {
    return { ran: false, reason: 'runtime-backed' };
  }

  const result = await ensureWorkspacePackagesBuiltForComponentImpl(serverDir, {
    quiet,
    env,
    buildMode: env[WORKSPACE_BUILD_MODE_ENV] ?? 'source-dev',
    ...(startup ? { startup, refresh } : {}),
    ...(signal ? { signal } : {}),
  });
  return { ran: true, reason: 'source-server', result };
}

export async function spawnSourceServerScript(
  { label = 'server', serverDir, script, env = process.env, quiet = false } = {},
  {
    ensureWorkspacePackagesBuiltForComponentImpl = ensureWorkspacePackagesBuiltForComponent,
    pmSpawnScriptImpl = pmSpawnScript,
  } = {},
) {
  await ensureSourceServerWorkspacePackagesBuilt(
    { runtimeBackedStart: false, serverDir, env, quiet, startup: true },
    { ensureWorkspacePackagesBuiltForComponentImpl },
  );
  await assertSharedDatabaseMigrationsApplied({ serverDir, env });
  return await pmSpawnScriptImpl({ label, dir: serverDir, script, env });
}
