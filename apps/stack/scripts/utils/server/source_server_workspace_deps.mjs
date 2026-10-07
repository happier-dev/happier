import { ensureWorkspacePackagesBuiltForComponent, pmSpawnScript } from '../proc/pm.mjs';
import { WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';

export async function ensureSourceServerWorkspacePackagesBuilt(
  {
    runtimeBackedStart = false,
    serverDir,
    env = process.env,
    quiet = false,
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
    { runtimeBackedStart: false, serverDir, env, quiet },
    { ensureWorkspacePackagesBuiltForComponentImpl },
  );
  return await pmSpawnScriptImpl({ label, dir: serverDir, script, env });
}
