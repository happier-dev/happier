import type {
    RuntimeTurnOperations,
    RuntimeTurnPromptMeta,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import type { AgentSessionModelsSource, AgentSessionModesSource } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    HostProviderInputOutcomeEvidence,
} from '@/agent/runtime/session/input/providerInputOutcome';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { SessionRollbackRuntimeFacet } from '@/agent/runtime/session/loop/sessionRollbackRpc';

export type PluginRuntimePromptAcceptedHandler = (info: Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
    deliveryBlockedReason?: string;
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
) => Promise<PluginRuntimeInFlightConfigApplyOutcome>;

export type PluginRuntimeHookOperations = RuntimeTurnOperations & Readonly<{
    /** null proves native custody; undefined means the applied identity is unavailable. */
    readAppliedTeamCredentialModel?: () => import('@happier-dev/protocol').TeamCredentialProviderModelSelectionV1 | null | undefined;
    /** Called once after this runtime opened, never used to infer subsequent auth state. */
    openedWithoutConnectedServices?: () => boolean;
    models?: AgentSessionModelsSource;
    modes?: AgentSessionModesSource;
    supportsInFlightSteer?: () => boolean;
    isTurnInFlight?: () => boolean;
    /** Declared new-turn delivery and canonical live/idle admission state. */
    canStartNewTurn?: () => boolean;
    canSteerPrompt?: () => boolean;
    canInterruptForPendingInput?: () => boolean;
    notifyPromptQueuedDuringTurn?: () => void;
    steerPrompt?: (message: string, options?: RuntimeTurnPromptMeta) => Promise<void>;
    applyConfigDeltaInFlight?: PluginRuntimeApplyConfigDeltaInFlight;
    setOnPromptDeliveryOutcome: (
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
    prepareRunTeamCredentialProviderBinding?: SessionRuntimeControls['prepareRunTeamCredentialProviderBinding'];
    managedProviderRunServices?: SessionRuntimeControls['managedProviderRunServices'];
}>;
