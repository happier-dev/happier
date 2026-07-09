export type AgentCliReadinessRequirementV1 = 'any' | 'all';

export type AgentCliReadinessStatusV1 = 'launchable' | 'missing' | 'blocked' | 'unknown';

export type AgentCliReadinessSourceV1 = 'override' | 'system' | 'managed';

export type AgentCliReadinessScopeV1 = 'launch';

export type AgentCliReadinessChecksV1 = Readonly<{
    /**
     * `launchable` means the host can resolve a launch command through its managed/system
     * provider CLI source of truth. It does not prove provider auth, account state, quota,
     * or build-policy availability unless a future check reports those explicitly.
     */
    launch: 'passed';
    auth: 'not_checked';
    buildPolicy: 'not_checked';
}>;

export type AgentCliReadinessDiagnosticV1 = Readonly<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    messageKey: string;
    detail?: Readonly<Record<string, unknown>>;
}>;

export type AgentCliLaunchableEntryV1 = Readonly<{
    agentId: string;
    status: 'launchable';
    scope: AgentCliReadinessScopeV1;
    checks: AgentCliReadinessChecksV1;
    source?: AgentCliReadinessSourceV1;
    diagnostics?: readonly AgentCliReadinessDiagnosticV1[];
}>;

export type AgentCliUnavailableEntryV1 = Readonly<{
    agentId: string;
    status: Exclude<AgentCliReadinessStatusV1, 'launchable'>;
    source?: AgentCliReadinessSourceV1;
    diagnostics?: readonly AgentCliReadinessDiagnosticV1[];
}>;

export type AgentCliReadinessEntryV1 = AgentCliLaunchableEntryV1 | AgentCliUnavailableEntryV1;

export type AgentCliReadinessQueryV1 = Readonly<{
    candidates: readonly string[];
    requirement: AgentCliReadinessRequirementV1;
    cwd?: string;
    accountId?: string;
    projectId?: string;
    workspaceId?: string;
    signal?: AbortSignal;
}>;

export type AgentCliReadinessResultV1 = Readonly<{
    status: AgentCliReadinessStatusV1;
    launchable: readonly AgentCliLaunchableEntryV1[];
    missing: readonly AgentCliReadinessEntryV1[];
    blocked: readonly AgentCliReadinessEntryV1[];
    unknown?: readonly AgentCliReadinessEntryV1[];
    diagnostics?: readonly AgentCliReadinessDiagnosticV1[];
}>;

export interface AgentCliRuntimeServiceV1 {
    checkReadiness(query: AgentCliReadinessQueryV1): Promise<AgentCliReadinessResultV1>;
}

export interface AgentsRuntimeServiceV1 {
    readonly cli: AgentCliRuntimeServiceV1;
}

export {
    AGENT_MODEL_CONFIG,
    CANONICAL_AGENT_AUTH_PROBE_CONFIG,
    CANONICAL_AGENT_CLI_RUNTIME_SPECS,
    CANONICAL_AGENT_LOCAL_CLI_CONFIG,
    CANONICAL_AGENT_SESSION_MODE_DESCRIPTORS,
    CANONICAL_AGENT_SESSION_MODES,
    CANONICAL_AGENTS_CORE,
    AGENTS_CORE,
} from '@happier-dev/agents';
export type {
    AgentCore,
    AgentModelConfig,
    AgentModelDescriptor,
    AgentModelOption,
} from '@happier-dev/agents';
