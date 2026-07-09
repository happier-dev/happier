import { ensureWorkspacePackagesBuiltForComponent, pmSpawnScript } from '../proc/pm.mjs';

export async function ensureSourceServerWorkspacePackagesBuilt(
  { runtimeBackedStart = false, serverDir, env = process.env, quiet = false } = {},
  { ensureWorkspacePackagesBuiltForComponentImpl = ensureWorkspacePackagesBuiltForComponent } = {},
) {
  if (runtimeBackedStart) {
    return { ran: false, reason: 'runtime-backed' };
  }

  const result = await ensureWorkspacePackagesBuiltForComponentImpl(serverDir, { quiet, env });
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
