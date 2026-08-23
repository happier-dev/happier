import type {
    RuntimeTurnOperations,
    RuntimeTurnPromptMeta,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import type { AgentSessionModelsSource } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    HostProviderInputOutcomeEvidence,
} from '@/agent/runtime/session/input/providerInputOutcome';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { SessionRollbackRuntimeFacet } from '@/agent/runtime/session/loop/sessionRollbackRpc';

export type PluginRuntimePromptAcceptedHandler = (info: Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>) => void;

export type PluginRuntimePromptDeliveryOutcome = HostProviderInputOutcomeEvidence;

export type PluginRuntimeClearTerminalComposer = (
    request: Readonly<{ sessionId: string; expectedStateAtMs?: number }>,
) => Promise<unknown> | unknown;

export type PluginRuntimeInterruptPendingInputAndRun = NonNullable<
    SessionRuntimeControls['interruptPendingInputAndRun']
>;

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
    models?: AgentSessionModelsSource;
    supportsInFlightSteer?: () => boolean;
    isTurnInFlight?: () => boolean;
    canSteerPrompt?: () => boolean;
    canInterruptForPendingInput?: () => boolean;
    notifyPromptQueuedDuringTurn?: () => void;
    steerPrompt?: (message: string, options?: RuntimeTurnPromptMeta) => Promise<void> | void;
    applyConfigDeltaInFlight?: PluginRuntimeApplyConfigDeltaInFlight;
    setOnPromptAcceptedByProvider?: (handler: PluginRuntimePromptAcceptedHandler | null) => void;
    setOnPromptDeliveryOutcome?: (
        handler: ((outcome: PluginRuntimePromptDeliveryOutcome) => void) | null,
    ) => void;
    setOnPromptTerminallyRejectedBeforeProvider?: (handler: PluginRuntimePromptAcceptedHandler | null) => void;
    clearTerminalComposer?: PluginRuntimeClearTerminalComposer;
    interruptPendingInputAndRun?: PluginRuntimeInterruptPendingInputAndRun;
    rollbackConversation?: SessionRollbackRuntimeFacet['rollbackConversation'];
    refreshGoal?: SessionRuntimeControls['refreshGoal'];
    setGoal?: SessionRuntimeControls['setGoal'];
    clearGoal?: SessionRuntimeControls['clearGoal'];
    listVendorPlugins?: SessionRuntimeControls['listVendorPlugins'];
    listSkills?: SessionRuntimeControls['listSkills'];
    checkUsageLimitRecoveryNow?: SessionRuntimeControls['checkUsageLimitRecoveryNow'];
    consumeUsageLimitResetCredit?: SessionRuntimeControls['consumeUsageLimitResetCredit'];
}>;
