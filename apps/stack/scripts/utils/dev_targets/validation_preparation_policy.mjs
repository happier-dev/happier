import { resolve } from 'node:path';
import { ENTRY_GRAPHS } from '../../perf/entry-graphs.mjs';
import { resolveRemoteValidationPreparationEnv } from './validation_env.mjs';

/** The preparation producer and placement reader consume the same scope. */
export function resolveRemoteValidationPreparationComponents(componentRelativeDir, validationKind, preparationScope = '') {
  if (!componentRelativeDir || componentRelativeDir === '.' || validationKind !== 'runtime') return [];
  if (preparationScope === 'entry-loads') return [...new Set(ENTRY_GRAPHS.map(graph => graph.preparationComponent ?? graph.cwd))];
  return componentRelativeDir === 'apps/ui' ? [componentRelativeDir, 'apps/cli'] : [componentRelativeDir];
}

export async function resolveRemoteValidationPlacementClass(policy, { repoRoot, env = process.env } = {}) {
  if (policy.commandClass !== 'targeted-validation') return policy.heavyClass;
  const components = resolveRemoteValidationPreparationComponents(policy.component, policy.kind, policy.preparationScope);
  if (!components.length) return policy.heavyClass;
  const { readWorkspaceBuildBatchDemand } = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  const demand = await readWorkspaceBuildBatchDemand(components.map(component => resolve(repoRoot, component)), {
    env: resolveRemoteValidationPreparationEnv(env, policy.kind, policy.preparationBuildMode), admissionClass: policy.heavyClass,
  });
  return demand?.admissionClass || policy.heavyClass;
}
