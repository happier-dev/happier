import type {
    BackendSurfaceAvailabilityV1,
    ExternalSessionsSource,
    ProviderBoundModelRef,
    RuntimeDescriptorV1,
    SubagentLifecycleDetailV1,
    SubagentStatusV1,
} from '@happier-dev/protocol';
import type { SessionStateUpdateV1 } from '@happier-dev/agents';
import type { SessionHandle } from '@happier-dev/plugin-sdk/sessions';
import type { AgentSessionConfigurationSnapshot } from '@happier-dev/plugin-sdk/agents/runtime';

export type HostTerminalAvailabilityOperation =
    | 'launch'
    | 'discoverIdentity';

export type HostTerminalAvailabilityRequest = Readonly<{
    operation: HostTerminalAvailabilityOperation;
    sessionId?: string;
    metadata?: Readonly<Record<string, unknown>>;
    directory?: string;
}>;

export type HostTerminalCurrentPublisherPermit = <T>(
    localEffect: () => Promise<T>,
) => Promise<
    | Readonly<{ status: 'completed'; value: T }>
    | Readonly<{ status: 'blocked' }>
>;

export type HostTerminalLaunchRequest = Readonly<{
    sessionId: string;
    metadata: Readonly<Record<string, unknown>>;
    configuration?: AgentSessionConfigurationSnapshot;
    modelSelection: ProviderBoundModelRef | null;
    runWithCurrentPublisherPermit: HostTerminalCurrentPublisherPermit;
    directory: string;
    isolation?: Readonly<{
        env?: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
    }> | null;
    env?: Readonly<Record<string, string>>;
    services?: SessionHandle;
    signal?: AbortSignal;
    host?: HostTerminalOrchestration;
}>;

export class HostTerminalModelSelectionBlockedError extends Error {
    readonly code = 'native_agent_terminal_model_selection_blocked' as const;

    constructor() {
        super(
            'Terminal launch is blocked until the current model transition is reconciled.',
        );
        this.name = 'HostTerminalModelSelectionBlockedError';
    }
}

/**
 * Typed terminal-follow admission failure for an Agent that declares explicit
 * terminal follow.
 *
 * `ES-PEP-03` requires baseline failure to launch no terminal process and
 * preserve the existing Session, and `ES-PEP-05` requires that `launch()`
 * cannot run before the follow binding is ready. Both outcomes surface as this
 * error so the caller can distinguish a follow admission barrier from a
 * terminal launch failure, and so an explicit later retry stays available.
 */
export class HostTerminalTranscriptFollowAdmissionError extends Error {
    readonly code =
        'native_agent_terminal_transcript_follow_admission_failed' as const;

    /** The typed follow code that closed admission. */
    readonly followCode: string;

    /**
     * `bind` failed before launch and created no child. `active` is a ready
     * binding that lost durable following while the terminal ran and won the
     * race against terminal completion.
     */
    readonly phase: 'bind' | 'active';

    constructor(followCode: string, phase: 'bind' | 'active') {
        super(
            `Terminal transcript follow admission failed (${phase}): ${followCode}`,
        );
        this.name = 'HostTerminalTranscriptFollowAdmissionError';
        this.followCode = followCode;
        this.phase = phase;
    }
}

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
    /** Resolves when durable transcript following fails after binding. */
    failure: Promise<Error>;
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
