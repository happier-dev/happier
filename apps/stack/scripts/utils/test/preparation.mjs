import { join } from 'node:path';

import { ensureWorkspacePackagesBuiltForComponent } from '../proc/pm.mjs';
import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';
import { bundleWorkspaceDeps } from '../../bundleWorkspaceDeps.mjs';
import { resolveWorkspaceBuildMode, WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';

export async function prepareStackTestWorkspacePackages(packageRoot, { integration = false, env = process.env } = {}) {
  const buildEnv = { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    buildMode: env[WORKSPACE_BUILD_MODE_ENV] ?? 'source-dev', env,
  }) };
  await ensureWorkspacePackagesBuiltForComponent(packageRoot, { quiet: true, env: buildEnv });
  const monorepoRoot = coerceHappyMonorepoRootFromPath(packageRoot);
  if (integration && monorepoRoot) {
    // Integration fixtures execute the server migration and CLI source entry
    // points, whose dist dependencies are outside Stack's own closure.
    for (const component of ['server', 'cli']) {
      await ensureWorkspacePackagesBuiltForComponent(join(monorepoRoot, 'apps', component), {
        quiet: true, env: buildEnv,
      });
    }
  }
  return { monorepoRoot, buildEnv };
}

export async function prepareStackTestRuntime(packageRoot, options = {}) {
  const prepared = await prepareStackTestWorkspacePackages(packageRoot, options);
  if (prepared.monorepoRoot) {
    // bin/hstack.mjs runs with the Stack package's installed/bundled layout.
    await bundleWorkspaceDeps({ repoRoot: prepared.monorepoRoot, stackDir: packageRoot, env: prepared.buildEnv });
  }
  return prepared;
}
