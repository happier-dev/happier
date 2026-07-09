import type {
    RuntimeTurnOperations,
    RuntimeTurnPromptMeta,
} from '@/agent/runtime/turns/runtimeTurnOperations';

export type PluginRuntimePromptAcceptedHandler = (info: Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>) => void;

export type PluginRuntimeUndeliverablePrompt = Readonly<{
    text: string;
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;

export type PluginRuntimeClearTerminalComposer = (
    request: Readonly<{ sessionId: string; expectedStateAtMs?: number }>,
) => Promise<unknown> | unknown;

export type PluginRuntimeInFlightConfigApplyOutcome = Readonly<
    | { status: 'applied' }
    | { status: 'scheduled_in_turn' }
    | { status: 'unsupported'; reason?: string | undefined }
    | { status: 'failed'; reason?: string | undefined }
>;

export type PluginRuntimeApplyConfigDeltaInFlight = (
    delta: Readonly<{ permissionMode: string }>,
) => Promise<PluginRuntimeInFlightConfigApplyOutcome> | PluginRuntimeInFlightConfigApplyOutcome;

export type PluginRuntimeHookOperations = RuntimeTurnOperations & Readonly<{
    supportsInFlightSteer?: () => boolean;
    isTurnInFlight?: () => boolean;
    canSteerPrompt?: () => boolean;
    steerPrompt?: (message: string, options?: RuntimeTurnPromptMeta) => Promise<void> | void;
    applyConfigDeltaInFlight?: PluginRuntimeApplyConfigDeltaInFlight;
    setOnPromptAcceptedByProvider?: (handler: PluginRuntimePromptAcceptedHandler | null) => void;
    setOnPromptTerminallyRejectedBeforeProvider?: (handler: PluginRuntimePromptAcceptedHandler | null) => void;
    setOnUndeliverablePrompts?: (
        handler: ((prompts: ReadonlyArray<PluginRuntimeUndeliverablePrompt>) => void) | null,
    ) => void;
    clearTerminalComposer?: PluginRuntimeClearTerminalComposer;
}>;
