import { resolve } from 'node:path';
import { resolveRemoteValidationPreparationEnv } from './validation_env.mjs';

/** The preparation producer and placement reader consume the same scope. */
export function resolveRemoteValidationPreparationComponents(componentRelativeDir, validationKind) {
  if (!componentRelativeDir || componentRelativeDir === '.' || validationKind !== 'runtime') return [];
  return componentRelativeDir === 'apps/ui' ? [componentRelativeDir, 'apps/cli'] : [componentRelativeDir];
}

export async function resolveRemoteValidationPlacementClass(policy, { repoRoot, env = process.env } = {}) {
  if (policy.commandClass !== 'targeted-validation') return policy.heavyClass;
  const components = resolveRemoteValidationPreparationComponents(policy.component, policy.kind);
  if (!components.length) return policy.heavyClass;
  const { readWorkspaceBuildBatchDemand } = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  const demand = await readWorkspaceBuildBatchDemand(components.map(component => resolve(repoRoot, component)), {
    env: resolveRemoteValidationPreparationEnv(env, policy.kind, policy.preparationBuildMode), admissionClass: policy.heavyClass,
  });
  return demand?.admissionClass || policy.heavyClass;
}
