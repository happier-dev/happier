import type { PluginServiceLaunchEnvironmentContributionV1 } from '@happier-dev/protocol/plugins/contributions/serviceLaunchEnvironments';
import type { WorktreePortsResultV1 } from '@happier-dev/protocol/workspaces/projectSetup/worktreePortsV1';

export type PluginServiceLaunchEnvironmentProjectionV1 = Readonly<{
    projectedEnvironment: Readonly<Record<string, string>>;
    provenance: Readonly<Record<string, Readonly<{ source: 'host' | 'dotenv' | 'runtime' | 'project' | 'profile' | 'invocation'; file?: string }>>>;
    diagnostics?: readonly Readonly<{ code: string; file?: string; name?: string }>[];
}>;
/** Private admitted preparation; this input is never an Action or review payload. */
export type PluginServiceLaunchEnvironmentInputV1 = Readonly<{
    workspace: Readonly<{ id: string; serverId: string; machineId: string; rootPath: string; createdAtMs?: number }>;
    project: Readonly<{ serverId: string; projectId: string }>;
    serviceId: string;
    executionPlacement: Readonly<{ mode: 'spawn' | 'native'; machineId: string }>;
    /** Previously retained ports under this contribution's local listener names. */
    assignedPorts: Readonly<Record<string, number>>;
    /** Demand after opt-in and eligibility. Ready assignment.listenerPorts uses these same local names. */
    requestListenerPorts?(keys: readonly string[]): Promise<WorktreePortsResultV1>;
    readEnvironment(): Promise<PluginServiceLaunchEnvironmentProjectionV1>;
}>;
export type PluginServiceLaunchEnvironmentResultV1 = Readonly<{ kind: 'unchanged' }>
    | Readonly<{ kind: 'unavailable'; code: 'service_launch_environment_unavailable' | 'service_launch_environment_failed'; reason?: string }>
    | Readonly<{ kind: 'replace'; replacements?: Readonly<Record<string, string>>; defaults?: Readonly<Record<string, string>>;
        release(): Promise<void> }>;
export type PluginServiceLaunchEnvironmentRuntimeV1 = Readonly<{
    prepare(input: PluginServiceLaunchEnvironmentInputV1): Promise<PluginServiceLaunchEnvironmentResultV1>;
}>;
export type PluginServiceLaunchEnvironmentDefinitionV1 = Readonly<{
    declaration: Omit<PluginServiceLaunchEnvironmentContributionV1, 'id'>;
    runtime: PluginServiceLaunchEnvironmentRuntimeV1;
}>;
