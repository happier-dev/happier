import { DEFAULT_DEPLOYMENT_RETAIN_PREVIOUS_DEPLOYMENTS_V1,
  type DeploymentCreationDefaultsV1, type ProjectDeploymentDefaultsPayloadV1,
  type ProjectSourceOwnerV1, type DeploymentCreationDefaultSourceV1,
  type ResolvedDeploymentCreationDefaultsV1 } from '@happier-dev/deployment-protocol';

export type { DeploymentCreationDefaultSourceV1, ResolvedDeploymentCreationDefaultsV1 } from '@happier-dev/deployment-protocol';
export type DeploymentCreationDefaultsInputV1 = Readonly<{
  /** Absent only for an unsaved Project whose reviewed intended owner is already known. */
  projectSourceId?: string;
  projectOwner: ProjectSourceOwnerV1;
  explicit?: Readonly<DeploymentCreationDefaultsV1>;
  projectDefaults?: Readonly<ProjectDeploymentDefaultsPayloadV1>;
  account?: Readonly<{ accountId: string; defaults: Readonly<DeploymentCreationDefaultsV1> }>;
  /** A configured own-server Environment may not have selected its first runtime yet. */
  target: Readonly<{ kind: 'ownServer'; machines: readonly string[] }>
    | Readonly<{ kind: 'platform'; creatingMachineId?: string }>;
}>;
function resolveValue<T>(explicit: T | undefined, project: T | undefined, account: T | undefined, builtin: T):
  Readonly<{ value: T; source: DeploymentCreationDefaultSourceV1 }> {
  if (explicit !== undefined) return { value: explicit, source: 'explicit' };
  if (project !== undefined) return { value: project, source: 'project' };
  if (account !== undefined) return { value: account, source: 'account' };
  return { value: builtin, source: 'builtin' };
}

/** Pure preparation only: inputs have passed their owners' schema/authority admission. */
export function resolveDeploymentCreationDefaultsV1(input: DeploymentCreationDefaultsInputV1): ResolvedDeploymentCreationDefaultsV1 {
  if (input.projectDefaults && input.projectDefaults.projectSourceId !== input.projectSourceId) {
    throw Object.assign(new Error('Project defaults belong to a different Source'), { code: 'project_defaults_scope_mismatch' });
  }
  const project = input.projectDefaults?.deploymentDefaults;
  const account = input.account && input.projectOwner.kind === 'account' && input.account.accountId === input.projectOwner.accountId
    ? input.account.defaults : undefined;
  const firstRuntime = input.target.kind === 'ownServer' ? input.target.machines[0] : undefined;
  // Platform targets own their build placement; own-server preferences cannot reroute it.
  const build = resolveValue(input.explicit?.buildMachineId,
    input.target.kind === 'ownServer' ? project?.buildMachineId : undefined,
    input.target.kind === 'ownServer' ? account?.buildMachineId : undefined, firstRuntime);
  const controller = resolveValue(input.explicit?.controllerMachineId, project?.controllerMachineId, account?.controllerMachineId,
    input.target.kind === 'ownServer' ? firstRuntime : input.target.creatingMachineId);
  const retention = resolveValue(input.explicit?.retainPreviousDeployments, project?.retainPreviousDeployments,
    account?.retainPreviousDeployments, DEFAULT_DEPLOYMENT_RETAIN_PREVIOUS_DEPLOYMENTS_V1);
  return {
    values: {
      ...(build.value !== undefined ? { buildMachineId: build.value } : {}),
      ...(controller.value !== undefined ? { controllerMachineId: controller.value } : {}),
      retainPreviousDeployments: retention.value,
    },
    sources: {
      ...(build.value !== undefined ? { buildMachineId: build.source } : {}),
      ...(controller.value !== undefined ? { controllerMachineId: controller.source } : {}),
      retainPreviousDeployments: retention.source,
    },
  };
}
