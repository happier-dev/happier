import { dirname, resolve } from 'node:path';

import { loadDevTargetExecutionConfig } from '../../apps/stack/scripts/utils/dev_targets/config.mjs';
import { runDevTargetCommand } from '../../apps/stack/scripts/utils/dev_targets/executor.mjs';
import { resolveRepoStackIdentity } from '../../apps/stack/scripts/utils/stack/repo_stack_identity.mjs';

/** Ignored dist belongs to each target. Dispatch its existing finite publisher
 * rather than copying another host's output or synchronizing build receipts. */
export async function prepareWorkspacePackageBuildTargets({
  repoRoot, env, packageNames, componentDirs,
  runDevTargetCommandImpl = runDevTargetCommand,
}) {
  const { stackName } = resolveRepoStackIdentity({ repoRoot });
  const { config, path } = await loadDevTargetExecutionConfig({ stackName, env });
  if (!config.targets.length) return null;
  const request = JSON.stringify({ packageNames, componentDirs });
  const results = await Promise.allSettled(config.targets.map(async target => {
    const result = await runDevTargetCommandImpl({
      target, stackBaseDir: dirname(path), sourceDir: resolve(repoRoot),
      commandArgs: ['node', './scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs', `--worker-request=${request}`],
      // The requested finite owner prepares exactly the selected package graph.
      workspacePreparation: 'skip',
      ...(env.HAPPIER_WORKSPACE_BUILD_MODE ? {
        environment: { HAPPIER_WORKSPACE_BUILD_MODE: env.HAPPIER_WORKSPACE_BUILD_MODE },
      } : {}),
      env,
    });
    if (result.code !== 0 || result.signal) {
      throw new Error(`[workspace-build] target ${target.name} failed: exit=${result.code ?? 'unknown'} signal=${result.signal ?? 'none'}`);
    }
    return target.name;
  }));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [new Error(`[workspace-build] target ${config.targets[index].name} preparation failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`, { cause: result.reason })] : []);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('; '));
  return { ok: true, built: [], skipped: [], preparedTargets: results.map(result => result.value) };
}
