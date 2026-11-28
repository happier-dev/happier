import type { PluginServiceLaunchEnvironmentContributionV1 } from '@happier-dev/protocol/plugins/contributions/serviceLaunchEnvironments';
import type { DatabaseWorktreeSourceV1, DatabaseWorktreeTargetV1 } from '@happier-dev/protocol/databases/databaseTargetIdentityV1';
import type { WorktreePortsResultV1 } from '@happier-dev/protocol/workspaces/projectSetup/worktreePortsV1';
import type { PluginDiagnosticDataV1 } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';

export type { PluginServiceLaunchEnvironmentContributionV1 };
export type PluginWorktreeDatabaseMemberV1 = Omit<DatabaseWorktreeTargetV1, 'source'> & Readonly<{
    source: Extract<DatabaseWorktreeSourceV1, { kind: 'service' }>;
}>;

export type PluginServiceLaunchEnvironmentProjectionV1 = Readonly<{
    projectedEnvironment: Readonly<Record<string, string>>;
    provenance: Readonly<Record<string, Readonly<{ source: 'host' | 'dotenv' | 'runtime' | 'project' | 'profile' | 'invocation'; file?: string }>>>;
    diagnostics?: readonly Readonly<{ code: string; file?: string; name?: string }>[];
}>;
/** Private admitted preparation; this input is never an Action or review payload. */
export type PluginServiceLaunchEnvironmentInputV1 = Readonly<{
    workspace: Readonly<{ id: string; serverId: string; machineId: string; rootPath: string; createdAtMs?: number; projectKey?: string }>;
    project: Readonly<{ serverId: string; projectId: string }>;
    /** Captured from this launch's admitted requester, never from a service declaration. */
    requester?: Readonly<{ accountId: string; installationId: string }>;
    serviceId: string;
    /** The admitted declaration name or native target label for display. */
    serviceName?: string;
    executionPlacement: Readonly<{ mode: 'spawn' | 'native'; machineId: string }>;
    /** Admitted physical execution-root comparison identity, equal to removal.worktreePath.
     * Host-private; retain verbatim so cleanup needs no filesystem lookup after deletion. */
    physicalRootIdentity: string;
    /** Previously retained ports under this contribution's local listener names. */
    assignedPorts: Readonly<Record<string, number>>;
    /** Demand after opt-in and eligibility. Ready assignment.listenerPorts uses these same local names. */
    requestListenerPorts?(keys: readonly string[]): Promise<WorktreePortsResultV1>;
    readEnvironment(): Promise<PluginServiceLaunchEnvironmentProjectionV1>;
    /** Original declared config projection from this same preparation; secret bindings stay excluded. */
    readDeclaredEnvironment?(): Promise<PluginServiceLaunchEnvironmentProjectionV1>;
    /** References supplied by discovery for this exact admitted launch. They contain no connection values. */
    readWorktreeDatabaseMembers?(): Promise<readonly PluginWorktreeDatabaseMemberV1[]>;
    /** Available during preparation only for the daemon Account's own Start. */
    admitWorktreeDatabaseAutomation?(target: PluginWorktreeDatabaseMemberV1): Promise<boolean>;
}>;
type UnavailableServiceLaunchEnvironmentV1 = Readonly<{
    kind: 'unavailable';
    code: 'service_launch_environment_unavailable' | 'service_launch_environment_failed';
    /** Private cause. The Service feed does not publish it. */
    reason?: string;
    /** Optional warning for the Service feed. Use public copy with no launch inputs or exception text. */
    diagnostic?: Readonly<Required<Pick<PluginDiagnosticDataV1, 'code' | 'message'>>>;
}>;
export type PluginServiceLaunchEnvironmentResultV1 = Readonly<{
    kind: 'unchanged';
    worktreeDatabaseMembers?: readonly PluginWorktreeDatabaseMemberV1[];
    /** Optional cleanup for an observation that does not change the launch. */
    release?(): Promise<void>;
}>
    | UnavailableServiceLaunchEnvironmentV1
    | Readonly<{ kind: 'replace'; replacements?: Readonly<Record<string, string>>; defaults?: Readonly<Record<string, string>>;
        /** A failed part of a contribution whose other bindings remain usable. */
        warning?: UnavailableServiceLaunchEnvironmentV1;
        release(): Promise<void> }>;
export type PluginServiceLaunchEnvironmentRuntimeV1 = Readonly<{
    /** The host makes discovery output available to other contributors in this preparation. */
    providesWorktreeDatabaseMembers?: true;
    prepare(input: PluginServiceLaunchEnvironmentInputV1): Promise<PluginServiceLaunchEnvironmentResultV1>;
}>;
export type PluginServiceLaunchEnvironmentDefinitionV1 = Readonly<{
    declaration: Omit<PluginServiceLaunchEnvironmentContributionV1, 'id'>;
    runtime: PluginServiceLaunchEnvironmentRuntimeV1;
}>;
