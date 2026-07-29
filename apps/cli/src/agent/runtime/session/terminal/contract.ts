import type {
    BackendSurfaceAvailabilityV1,
    ExternalSessionsSource,
    RuntimeDescriptorV1,
    SubagentLifecycleDetailV1,
    SubagentStatusV1,
} from '@happier-dev/protocol';
import type { SessionScopedServicesV1, SessionStateUpdateV1 } from '@happier-dev/agents';

export type HostTerminalAvailabilityOperation =
    | 'launch'
    | 'discoverIdentity';

export type HostTerminalAvailabilityRequest = Readonly<{
    operation: HostTerminalAvailabilityOperation;
    sessionId?: string;
    metadata?: Readonly<Record<string, unknown>>;
    directory?: string;
}>;

export type HostTerminalLaunchRequest = Readonly<{
    sessionId: string;
    metadata: Readonly<Record<string, unknown>>;
    directory: string;
    isolation?: Readonly<{
        env?: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
    }> | null;
    env?: Readonly<Record<string, string>>;
    services?: SessionScopedServicesV1;
    signal?: AbortSignal;
    host?: HostTerminalOrchestration;
}>;

export type HostTerminalInputTrigger = Readonly<{
    sequence: number;
}>;

export type HostTerminalInputTriggerHandler = (
    trigger: HostTerminalInputTrigger,
) => void | Promise<void>;

export type HostTerminalInputTriggerService = Readonly<{
    subscribe(handler: HostTerminalInputTriggerHandler): Readonly<{ unsubscribe(): void }>;
}>;

export type HostTerminalSwitchTarget = 'local' | 'remote' | 'unknown';

export type HostTerminalSwitchRequest = Readonly<{
    target: HostTerminalSwitchTarget;
}>;

export type HostTerminalSwitchHandler = (
    request: HostTerminalSwitchRequest,
) => boolean | Promise<boolean>;

export type HostTerminalSwitchHandlerService = Readonly<{
    register(handler: HostTerminalSwitchHandler): Readonly<{ unsubscribe(): void }>;
}>;

export type HostTerminalProcessExecutableGrantKind = 'system-tool' | 'agent-cli';

export type HostTerminalProcessExecutableGrant = Readonly<{
    kind: HostTerminalProcessExecutableGrantKind;
    grantId: string;
}>;

export type HostTerminalProcessExecutable = Readonly<{
    path: string;
    hostGrant: HostTerminalProcessExecutableGrant;
}>;

export type HostTerminalProcessStdio = 'inherit' | 'pipe';

export type HostTerminalProcessLaunchRequest = Readonly<{
    executable: HostTerminalProcessExecutable;
    args?: readonly string[];
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
    unsetEnvKeys?: readonly string[];
    stdio?: HostTerminalProcessStdio;
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
    signal?: AbortSignal;
}>;

export type HostTerminalAgentCliResolutionRequest = Readonly<{
    agentId: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
}>;

export type HostTerminalAgentCliResolution = Readonly<{
    executable: HostTerminalProcessExecutable;
    args: readonly string[];
    source: string;
    resolvedPath: string;
}>;

export type HostTerminalProcessTermination =
    | Readonly<{ type: 'exited'; code: number }>
    | Readonly<{ type: 'signaled'; signal: string }>
    | Readonly<{ type: 'spawn_error'; errorName: string; errorMessage: string }>
    | Readonly<{ type: 'missing' }>;

export type HostTerminalProcessHandle = Readonly<{
    pid: number | null;
    waitForTermination(): Promise<HostTerminalProcessTermination>;
    stop(options?: Readonly<{ graceMs?: number }>): Promise<void>;
    readBufferedStderr?(): string;
}>;

export type HostTerminalProcessService = Readonly<{
    resolveAgentCliExecutable?(
        request: HostTerminalAgentCliResolutionRequest,
    ): Promise<HostTerminalAgentCliResolution>;
    launch(request: HostTerminalProcessLaunchRequest): Promise<HostTerminalProcessHandle>;
}>;

export type HostTerminalControlProjection = Readonly<{
    target: HostTerminalSwitchTarget;
    reason?: string;
    providerSessionId?: string;
    sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type HostTerminalProviderSessionProjection = Readonly<{
    providerSessionId: string;
    metadataKey: string;
    source?: ExternalSessionsSource;
    sessionStateUpdates?: readonly SessionStateUpdateV1[];
    providerEvidence?: Readonly<Record<string, unknown>>;
}>;

export type HostTerminalSubagentProjection = Readonly<{
    agentId?: string;
    agentKind?: string;
    providerSessionId?: string;
    subagentId: string;
    label?: string;
    role?: string;
    sidechainId?: string;
    status?: SubagentStatusV1;
    lifecycleDetail?: SubagentLifecycleDetailV1;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type HostTerminalProjectionService = Readonly<{
    publishControlState(projection: HostTerminalControlProjection): void | Promise<void>;
    publishProviderSessionId(projection: HostTerminalProviderSessionProjection): boolean | Promise<boolean>;
    publishSubagentStarted(projection: HostTerminalSubagentProjection): void | Promise<void>;
    publishSubagentCompleted(projection: HostTerminalSubagentProjection): void | Promise<void>;
}>;

export type HostTerminalTranscriptFollowBinding = Readonly<{
    dispose(): Promise<void>;
}>;

export type HostTerminalTranscriptFollowBindResult =
    | Readonly<{
        status: 'following';
        startingCursor: string | null;
        binding: HostTerminalTranscriptFollowBinding;
    }>
    | Readonly<{
        status: 'unavailable';
        code: string;
    }>;

export type HostTerminalTranscriptFollowService = Readonly<{
    bindProviderSession(request: Readonly<{
        agentId: string;
        providerSessionId: string;
        cursor?: string;
        signal?: AbortSignal;
    }>): Promise<HostTerminalTranscriptFollowBindResult>;
    releaseActiveBindings(): Promise<void>;
}>;

export type HostTerminalOrchestration = Readonly<{
    input: HostTerminalInputTriggerService;
    switching: HostTerminalSwitchHandlerService;
    process: HostTerminalProcessService;
    projection: HostTerminalProjectionService;
    transcriptFollow?: HostTerminalTranscriptFollowService;
}>;

export type HostTerminalControlReturnReason =
    | 'switch_requested'
    | 'pending_input'
    | 'terminal_recovery';

export type HostTerminalRunResult =
    | Readonly<{
        type: 'process_exited';
        exitCode: number;
        sessionStateUpdates?: readonly SessionStateUpdateV1[];
    }>
    | Readonly<{
        type: 'control_returned';
        reason: HostTerminalControlReturnReason;
        providerSessionId?: string;
        sessionStateUpdates?: readonly SessionStateUpdateV1[];
    }>;

export type HostTerminalIdentityRequest = Readonly<{
    sessionId: string;
    metadata: Readonly<Record<string, unknown>>;
}>;

export type HostTerminalIdentityResult = Readonly<{
    providerSessionId: string;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type HostTerminalExecutionSurface = Readonly<{
    evaluateAvailability?: (
        request: HostTerminalAvailabilityRequest,
    ) => BackendSurfaceAvailabilityV1 | Promise<BackendSurfaceAvailabilityV1>;
    launch?: (request: HostTerminalLaunchRequest) => HostTerminalRunResult | Promise<HostTerminalRunResult>;
    discoverIdentity?: (
        request: HostTerminalIdentityRequest,
    ) => HostTerminalIdentityResult | null | Promise<HostTerminalIdentityResult | null>;
}>;
