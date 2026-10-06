import {
    createCatalogHostSessionRuntimeConfig,
    createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/catalogPlan';
import type { HostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import type {
    HostRuntimeReplacementLifecycle,
    HostSessionRuntimeConfig,
    HostSessionRuntimeFactoryParams,
    HostSessionRuntimeStartupSeed,
    HostSessionRuntimeRunOptions,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { readRequiredStartupMachineId } from '@/agent/runtime/startup/readRequiredStartupMachineId';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type {
    RuntimeTurnCompletionOptions,
    RuntimeTurnConfigUpdate,
    RuntimeTurnMessageHandler,
    RuntimeTurnPromptMeta,
    RuntimeTurnSessionOpenIntent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    normalizeBuiltInAgentId,
    resolveContributionCatalogAgentId,
} from '@/plugins/projection/registry/resolveContributionCatalogAgentId';
import type {
    EngineResolutionAgent,
    EngineResolutionBackend,
} from '@/agent/runtime/registry/engineRegistryTypes';
import { createProviderTerminalDisplay } from '@/ui/providers/providerTerminalDisplay';
import {
    getAgentResumeConfig,
    resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildUnsupportedSessionPendingInputInterruptAndRunResult } from '@happier-dev/protocol/sessions/control/pendingInputInterruptAndRunV1';
import { buildUnsupportedSessionTerminalComposerClearResult } from '@happier-dev/protocol/sessions/control/terminalComposerClearV1';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { SessionModelSelectionResolutionError, SessionModelSelectionV1Schema, resolveSessionModelSelectionInputRefV1 } from '@happier-dev/protocol/providers/model-selection';
import type { SessionModelSelectionV1, AgentSessionStartupInstructionsV1 } from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type {
  AgentSessionConfigurationSnapshot,
  AgentSessionHostServices,
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { NativeForkSource } from '@/session/shared/spawnSessionContract';
import type { ProviderBindingLaunchHandoffV1 } from '@/plugins/runtime/providerBindings/handoff';
import { logger } from '@/ui/logger';
import {
    resolveReleasedCodexStartupOverridesCacheV1Compatibility,
} from '@/agent/runtime/startup/releasedStartupOverridesCacheV1';
import { configuration } from '@/configuration';
import type { PermissionMode } from '@/api/types';

import type {
    PluginRuntimeApplyConfigDeltaInFlight,
    PluginRuntimeClearTerminalComposer,
    PluginRuntimeHookOperations,
    PluginRuntimeInterruptPendingInputAndRun,
    PluginRuntimeInFlightConfigApplyOutcome,
    PluginRuntimePromptAcceptedHandler,
    PluginRuntimePromptDeliveryOutcome,
} from './sessionRuntimeHooks';
import {
    buildPluginHostSessionRuntimeOptions,
    type PluginSessionBindingInput,
} from './sessionLaunch';

type NativeAgentSessionOpenIntent =
    | Readonly<{ kind: 'create'; startupInstructions?: AgentSessionStartupInstructionsV1 | null }>
    | Readonly<{
        kind: 'resume';
        providerSessionId: string;
        importHistory: boolean;
        strictNativeResumeIdentity?: boolean;
        startupInstructions?: AgentSessionStartupInstructionsV1 | null;
    }>
    | Readonly<{ kind: 'fork'; source: NativeForkSource }>;

type NativeAgentSessionRuntimeCreation = Readonly<{
    operations: PluginRuntimeHookOperations;
    configuration?: AgentSessionConfigurationSnapshot | null;
    runtimeCapabilities?: HostSessionRuntimeFactoryResult<PluginRuntimeHookOperations>['runtimeCapabilities'];
    admittedProviderBindingHandoff?: ProviderBindingLaunchHandoffV1 | null;
}>;

type NativeAgentSessionRuntimeCreate = (
    intent: NativeAgentSessionOpenIntent,
    hostRuntime: HostSessionRuntimeFactoryParams,
) => PluginRuntimeHookOperations
    | NativeAgentSessionRuntimeCreation
    | Promise<PluginRuntimeHookOperations | NativeAgentSessionRuntimeCreation>;

async function normalizeNativeAgentSessionRuntimeCreation(
    created: PluginRuntimeHookOperations | NativeAgentSessionRuntimeCreation,
): Promise<NativeAgentSessionRuntimeCreation> {
    const normalized = 'operations' in created ? created : { operations: created };
    if (typeof normalized.operations.setOnPromptDeliveryOutcome !== 'function') {
        await normalized.operations.resetOrDisposeRuntime('runtime_recovery').catch(() => undefined);
        throw new Error(
            'An admitted Agent Session runtime must provide the canonical provider delivery outcome port',
        );
    }
    return normalized;
}

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * The catalog-declared flat `<vendor>SessionId` slot, which exists for bundled
 * Agents only.
 *
 * `null` is the normal answer for a contributed Agent and no longer means its
 * native id is dropped: the identity subscription publishes the id without a
 * flat key and the session-state binding routes it to `nativeResumeIdentityV1`,
 * which is what the resume readers consult once the descriptor attributes the
 * identity to the current Agent.
 *
 * (A previous revision also probed `richDefinition.definition.core.resume`.
 * `richDefinition.definition` is a strict `PluginAgentContributionV2` for both
 * provenances and declares no `core`, so that branch could never fire.)
 */
function resolveNativeAgentVendorResumeIdField(policyAgentId: string): string | null {
    const bundledAgentId = normalizeBuiltInAgentId(policyAgentId);
    if (!bundledAgentId) return null;
    return normalizeNonEmptyString(getAgentResumeConfig(bundledAgentId)?.vendorResumeIdField);
}

function bindReplaceableNativeAgentSessionOperations(params: Readonly<{
    initialRuntime: NativeAgentSessionRuntimeCreation;
    recreateOperations?: (
        intent: RuntimeTurnSessionOpenIntent,
    ) => Promise<NativeAgentSessionRuntimeCreation>;
}>): PluginRuntimeHookOperations & Readonly<{
    setRuntimeReplacementLifecycle?: (lifecycle: HostRuntimeReplacementLifecycle) => void;
}> {
    if (!params.recreateOperations) {
        return params.initialRuntime.operations;
    }

    let currentOperations = params.initialRuntime.operations;
    const hasRollbackConversation = currentOperations.rollbackConversation !== undefined;
    const hasRefreshGoal = currentOperations.refreshGoal !== undefined;
    const hasSetGoal = currentOperations.setGoal !== undefined;
    const hasClearGoal = currentOperations.clearGoal !== undefined;
    const hasListVendorPlugins = currentOperations.listVendorPlugins !== undefined;
    const hasListSkills = currentOperations.listSkills !== undefined;
    const hasCheckUsageLimitRecoveryNow = currentOperations.checkUsageLimitRecoveryNow !== undefined;
    const hasConsumeUsageLimitResetCredit = currentOperations.consumeUsageLimitResetCredit !== undefined;
    const hasInterruptPendingInputAndRun =
        currentOperations.interruptPendingInputAndRun !== undefined;
    const hasPrepareRunTeamCredentialProviderBinding =
        currentOperations.prepareRunTeamCredentialProviderBinding !== undefined;
    const hasPrepareTerminalPresentation =
        currentOperations.prepareTerminalPresentation !== undefined;
    let runtimeClosed = false;
    let runtimeBindingEpoch = 0;
    let stableRuntimeOperations: PluginRuntimeHookOperations | null = null;
    let replacementLifecycle: HostRuntimeReplacementLifecycle | null = null;
    const runtimeEventHandlers = new Set<RuntimeTurnMessageHandler>();
    let runtimeEventUnsubscribe: (() => void) | null = null;
    let promptDeliveryOutcomeHandler: ((outcome: PluginRuntimePromptDeliveryOutcome) => void) | null = null;
    let promptTerminallyRejectedHandler: PluginRuntimePromptAcceptedHandler | null = null;
    const hasModelsSource = params.initialRuntime.operations.models !== undefined;
    const modelSubscribers = new Set<(snapshot: AgentSessionModelsSnapshot) => void>();
    let modelSourceUnsubscribe: ReturnType<AgentSessionModelsSource['subscribe']> | null = null;
    let modelSnapshot: AgentSessionModelsSnapshot = Object.freeze({ models: null });

    const publishModelSnapshot = (snapshot: AgentSessionModelsSnapshot): void => {
        modelSnapshot = Object.freeze({ ...snapshot });
        for (const subscriber of Array.from(modelSubscribers)) subscriber(modelSnapshot);
    };

    const detachModelSource = (): void => {
        const unsubscribe = modelSourceUnsubscribe;
        modelSourceUnsubscribe = null;
        unsubscribe?.dispose();
    };

    const attachModelSource = (): void => {
        detachModelSource();
        const source = currentOperations.models;
        if (!source) {
            publishModelSnapshot({ models: null });
            return;
        }
        const bindingEpoch = runtimeBindingEpoch;
        const apply = (snapshot: AgentSessionModelsSnapshot): void => {
            if (runtimeClosed || bindingEpoch !== runtimeBindingEpoch) return;
            publishModelSnapshot({
                models: snapshot.models,
                ...(snapshot.currentModelId === undefined ? {} : { currentModelId: snapshot.currentModelId }),
            });
        };
        apply(source.read());
        modelSourceUnsubscribe = source.subscribe(apply);
    };

    const stableModels: AgentSessionModelsSource | undefined = hasModelsSource
        ? Object.freeze({
            read: () => modelSnapshot,
            subscribe(handler: (snapshot: AgentSessionModelsSnapshot) => void) {
                modelSubscribers.add(handler);
                handler(modelSnapshot);
                return Object.freeze({
                    dispose: () => {
                        modelSubscribers.delete(handler);
                    },
                });
            },
        })
        : undefined;
    if (hasModelsSource) attachModelSource();

    const detachRuntimeEvents = (): void => {
        const unsubscribe = runtimeEventUnsubscribe;
        runtimeEventUnsubscribe = null;
        unsubscribe?.();
    };

    const attachRuntimeEvents = (): void => {
        detachRuntimeEvents();
        if (runtimeEventHandlers.size === 0) return;
        const bindingEpoch = runtimeBindingEpoch;
        runtimeEventUnsubscribe = currentOperations.subscribeRuntimeEvents((event) => {
            if (runtimeClosed || bindingEpoch !== runtimeBindingEpoch) return;
            for (const handler of Array.from(runtimeEventHandlers)) {
                handler(event);
            }
        });
    };

    const detachRuntimeSources = (): void => {
        let firstError: unknown;
        let hasError = false;
        for (const detach of [detachRuntimeEvents, detachModelSource]) {
            try {
                detach();
            } catch (error) {
                if (!hasError) firstError = error;
                hasError = true;
            }
        }
        if (hasError) throw firstError;
    };

    const bindProviderInputHandlersToCurrentRuntime = (): void => {
        const bindingEpoch = runtimeBindingEpoch;
        currentOperations.setOnPromptDeliveryOutcome(promptDeliveryOutcomeHandler
            ? (outcome) => {
                if (runtimeClosed || bindingEpoch !== runtimeBindingEpoch) return;
                promptDeliveryOutcomeHandler?.(outcome);
            }
            : null);
        currentOperations.setOnPromptTerminallyRejectedBeforeProvider?.(promptTerminallyRejectedHandler
            ? (info) => {
                if (runtimeClosed || bindingEpoch !== runtimeBindingEpoch) return;
                promptTerminallyRejectedHandler?.(info);
            }
            : null);
    };

    const reapplyRuntimeHandlers = (): void => {
        bindProviderInputHandlersToCurrentRuntime();
    };

    const recreateClosedRuntime = async (intent: RuntimeTurnSessionOpenIntent): Promise<boolean> => {
        if (!runtimeClosed) return false;
        const nextRuntime = await params.recreateOperations?.(intent);
        if (!nextRuntime) return false;
        const nextOperations = nextRuntime.operations;
        try {
            if (nextRuntime.admittedProviderBindingHandoff) {
                await replacementLifecycle?.onSuccessorProviderBindingAdmitted?.(
                    nextRuntime.admittedProviderBindingHandoff,
                );
            }
            currentOperations = nextOperations;
            runtimeBindingEpoch += 1;
            reapplyRuntimeHandlers();
            await replacementLifecycle?.onSuccessorBound();
            runtimeClosed = false;
            if (hasModelsSource) attachModelSource();
            attachRuntimeEvents();
            return true;
        } catch (error) {
            runtimeBindingEpoch += 1;
            try {
                detachRuntimeSources();
            } catch {
                // Preserve the binding failure while still disposing the rejected successor.
            }
            runtimeClosed = true;
            await nextOperations.resetOrDisposeRuntime().catch(() => undefined);
            throw error;
        }
    };

    stableRuntimeOperations = Object.freeze({
        setRuntimeReplacementLifecycle(lifecycle: HostRuntimeReplacementLifecycle) {
            replacementLifecycle = lifecycle;
        },
        ...(stableModels ? { models: stableModels } : {}),
        get permissionCapability() {
            return currentOperations.permissionCapability;
        },
        getRuntimeLifetimeSignal: () => currentOperations.getRuntimeLifetimeSignal?.() ?? null,
        readActiveTurnPermissionWitness: () => currentOperations.readActiveTurnPermissionWitness?.() ?? null,
        readActiveTurnInputId: () => currentOperations.readActiveTurnInputId?.() ?? null,
        readActiveTurnAdmissionWitness: () => currentOperations.readActiveTurnAdmissionWitness?.() ?? null,
        beginTurnLifecycle() {
            currentOperations.beginTurnLifecycle();
        },
        async sendTurnPrompt(prompt: string, meta?: RuntimeTurnPromptMeta) {
            await currentOperations.sendTurnPrompt(prompt, meta);
        },
        async steerInFlightTurn(message: string, meta?: RuntimeTurnPromptMeta) {
            await currentOperations.steerInFlightTurn(message, meta);
        },
        async steerPrompt(message, options) {
            const steerPrompt = currentOperations.steerPrompt
                ?? currentOperations.steerInFlightTurn;
            await steerPrompt.call(currentOperations, message, options);
        },
        supportsInFlightSteer: () => currentOperations.supportsInFlightSteer?.() ?? false,
        isTurnInFlight: () => currentOperations.isTurnInFlight?.() ?? false,
        canSteerPrompt: () => currentOperations.canSteerPrompt?.() ?? false,
        canInterruptForPendingInput: () => currentOperations.canInterruptForPendingInput?.() ?? true,
        notifyPromptQueuedDuringTurn: () => currentOperations.notifyPromptQueuedDuringTurn?.(),
        async applyConfigDeltaInFlight(
            delta: Parameters<PluginRuntimeApplyConfigDeltaInFlight>[0],
        ): Promise<PluginRuntimeInFlightConfigApplyOutcome> {
            const apply = currentOperations.applyConfigDeltaInFlight;
            if (!apply) {
                return {
                    status: 'unsupported',
                    reason: 'runtime_without_in_flight_config_capability',
                };
            }
            return await apply(delta);
        },
        setOnPromptDeliveryOutcome(handler: ((outcome: PluginRuntimePromptDeliveryOutcome) => void) | null) {
            promptDeliveryOutcomeHandler = handler;
            bindProviderInputHandlersToCurrentRuntime();
        },
        setOnPromptTerminallyRejectedBeforeProvider(handler: PluginRuntimePromptAcceptedHandler | null) {
            promptTerminallyRejectedHandler = handler;
            bindProviderInputHandlersToCurrentRuntime();
        },
        clearTerminalComposer(request: Parameters<PluginRuntimeClearTerminalComposer>[0]) {
            return currentOperations.clearTerminalComposer?.(request)
                ?? buildUnsupportedSessionTerminalComposerClearResult(
                    request.sessionId,
                    'session.terminalComposer.clear',
                );
        },
        ...(hasInterruptPendingInputAndRun
            ? {
                interruptPendingInputAndRun(
                    request: Parameters<PluginRuntimeInterruptPendingInputAndRun>[0],
                ) {
                    const control =
                        currentOperations.interruptPendingInputAndRun;
                    if (!control) {
                        return buildUnsupportedSessionPendingInputInterruptAndRunResult(
                            request.sessionId,
                            request.localId,
                            'session.pendingInput.interruptAndRun',
                        );
                    }
                    return control(request);
                },
            }
            : {}),
        ...(hasRollbackConversation
            ? {
                async rollbackConversation(
                    request: Parameters<NonNullable<PluginRuntimeHookOperations['rollbackConversation']>>[0],
                ) {
                    const control = currentOperations.rollbackConversation;
                    if (!control) {
                        return {
                            ok: false as const,
                            errorCode: 'native_conversation_rollback_unavailable',
                            errorMessage: 'Native Agent conversation rollback is unavailable.',
                        };
                    }
                    return await control(request);
                },
            }
            : {}),
        ...(hasRefreshGoal
            ? {
                refreshGoal: () => currentOperations.refreshGoal?.() ?? {
                    ok: false as const,
                    errorCode: 'native_goal_control_unavailable',
                    error: 'native_goal_control_unavailable',
                },
            }
            : {}),
        ...(hasSetGoal
            ? {
                setGoal: (
                    objective: Parameters<NonNullable<PluginRuntimeHookOperations['setGoal']>>[0],
                    options?: Parameters<NonNullable<PluginRuntimeHookOperations['setGoal']>>[1],
                ) => currentOperations.setGoal?.(objective, options) ?? {
                    ok: false as const,
                    errorCode: 'native_goal_control_unavailable',
                    error: 'native_goal_control_unavailable',
                },
            }
            : {}),
        ...(hasClearGoal
            ? {
                clearGoal: () => currentOperations.clearGoal?.() ?? {
                    ok: false as const,
                    errorCode: 'native_goal_control_unavailable',
                    error: 'native_goal_control_unavailable',
                },
            }
            : {}),
        ...(hasListVendorPlugins
            ? {
                listVendorPlugins: (
                    options?: Parameters<NonNullable<PluginRuntimeHookOperations['listVendorPlugins']>>[0],
                ) => currentOperations.listVendorPlugins?.(options) ?? Promise.resolve({
                    unsupported: true,
                    vendorPlugins: [],
                }),
            }
            : {}),
        ...(hasListSkills
            ? {
                listSkills: (
                    options?: Parameters<NonNullable<PluginRuntimeHookOperations['listSkills']>>[0],
                ) => currentOperations.listSkills?.(options) ?? Promise.resolve({
                    unsupported: true,
                    skills: [],
                }),
            }
            : {}),
        ...(hasCheckUsageLimitRecoveryNow
            ? {
                checkUsageLimitRecoveryNow: (
                    request: Parameters<NonNullable<PluginRuntimeHookOperations['checkUsageLimitRecoveryNow']>>[0],
                ) => currentOperations.checkUsageLimitRecoveryNow?.(request) ?? {
                    status: 'unavailable',
                    diagnostic: { code: 'native_usage_limit_recovery_unavailable' },
                    retryable: true,
                },
            }
            : {}),
        ...(hasConsumeUsageLimitResetCredit
            ? {
                consumeUsageLimitResetCredit: (
                    request: Parameters<NonNullable<PluginRuntimeHookOperations['consumeUsageLimitResetCredit']>>[0],
                ) => currentOperations.consumeUsageLimitResetCredit?.(request) ?? {
                    status: 'unavailable',
                    diagnostic: { code: 'native_usage_limit_recovery_unavailable' },
                    retryable: true,
                },
            }
            : {}),
        ...(hasPrepareRunTeamCredentialProviderBinding
            ? {
                prepareRunTeamCredentialProviderBinding: (
                    request: Parameters<NonNullable<PluginRuntimeHookOperations['prepareRunTeamCredentialProviderBinding']>>[0],
                ) => currentOperations.prepareRunTeamCredentialProviderBinding?.(request) ?? Promise.resolve(null),
            }
            : {}),
        async waitForTurnCompletion(opts?: RuntimeTurnCompletionOptions) {
            await currentOperations.waitForTurnCompletion(opts);
        },
        subscribeRuntimeEvents(handler: RuntimeTurnMessageHandler) {
            runtimeEventHandlers.add(handler);
            if (runtimeEventHandlers.size === 1) {
                attachRuntimeEvents();
            }
            return () => {
                runtimeEventHandlers.delete(handler);
                if (runtimeEventHandlers.size === 0) {
                    detachRuntimeEvents();
                }
            };
        },
        async respondToPermission(requestId: string, approved: boolean) {
            const respondToPermission = currentOperations.respondToPermission;
            if (!respondToPermission) {
                return { delivered: false, reason: 'unknown_request' } as const;
            }
            return await respondToPermission(requestId, approved);
        },
        async cancelTurn() {
            await currentOperations.cancelTurn();
        },
        ...(hasPrepareTerminalPresentation
            ? {
                async prepareTerminalPresentation(request: Parameters<NonNullable<PluginRuntimeHookOperations['prepareTerminalPresentation']>>[0]) {
                    const prepare = currentOperations.prepareTerminalPresentation;
                    if (!prepare) {
                        throw new Error('Provider CLI attach is unavailable for the active runtime');
                    }
                    return await prepare(request);
                },
            }
            : {}),
        readSessionIdentity() {
            return currentOperations.readSessionIdentity();
        },
        readSessionStartupInstructions: () => currentOperations.readSessionStartupInstructions?.() ?? null,
        async updateSessionRuntimeConfig(update: RuntimeTurnConfigUpdate) {
            return await currentOperations.updateSessionRuntimeConfig(update);
        },
        async resetOrDisposeRuntime(reason, nextSessionOpenIntent) {
            await replacementLifecycle?.beforeReplacement();
            runtimeClosed = true;
            runtimeBindingEpoch += 1;
            let detachError: unknown;
            let detachFailed = false;
            try {
                detachRuntimeSources();
            } catch (error) {
                detachError = error;
                detachFailed = true;
            }
            if (hasModelsSource) publishModelSnapshot({ models: null });
            try {
                await currentOperations.resetOrDisposeRuntime(reason);
            } finally {
                runtimeClosed = true;
            }
            if (detachFailed) throw detachError;
            if (nextSessionOpenIntent) {
                const recreated = await recreateClosedRuntime(nextSessionOpenIntent);
                if (recreated) {
                    try {
                        await replacementLifecycle?.onSuccessorUsable();
                    } catch (error) {
                        runtimeClosed = true;
                        runtimeBindingEpoch += 1;
                        try {
                            detachRuntimeSources();
                        } catch {
                            // Preserve the successor usability failure while still disposing it.
                        }
                        await currentOperations.resetOrDisposeRuntime().catch(() => undefined);
                        throw error;
                    }
                }
            }
        },
    });
    return stableRuntimeOperations;
}

export function resolvePublicSessionModelSelection(params: Readonly<{
    sessionInput: PluginSessionBindingInput;
    metadata: Readonly<Record<string, unknown>>;
}>): SessionModelSelectionV1 | undefined {
    const hasMetadataIntent = Object.prototype.hasOwnProperty.call(params.metadata, 'modelSelectionIntentV1')
        || Object.prototype.hasOwnProperty.call(params.metadata, 'modelOverrideV1');
    if (!hasMetadataIntent) return params.sessionInput.runtimePreferences.modelSelection;

    const backendTarget = params.sessionInput.bootstrap.target
        ? readBackendTargetRefV2(params.sessionInput.bootstrap.target)
        : resolveBackendTargetFromSessionMetadata(params.metadata);
    const targetKey = backendTarget
        ? buildBackendTargetKeyV2(backendTarget)
        : params.sessionInput.runtimePreferences.modelSelection?.ref.agentTargetKey ?? null;
    if (!targetKey) {
        throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
    }
    const intent = resolveModelSelectionIntentFromSessionMetadata(params.metadata, targetKey);
    return intent?.selection
        ? SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: intent.updatedAt,
            ref: intent.selection,
        })
        : undefined;
}

function resolveInitialNativeAgentSessionOpenIntent(
    sessionInput: PluginSessionBindingInput,
    strictNativeResumeIdentity: boolean,
): NativeAgentSessionOpenIntent {
    const providerSessionId = readNonBlankOpaqueIdentifier(sessionInput.resume.resumeSessionId);
    const nativeForkSource = sessionInput.nativeForkSource;
    if (nativeForkSource) {
        return Object.freeze({ kind: 'fork', source: nativeForkSource });
    }
    if (providerSessionId) {
        return Object.freeze({
            kind: 'resume',
            providerSessionId,
            importHistory: true,
            ...(strictNativeResumeIdentity
                ? { strictNativeResumeIdentity: true }
                : {}),
        });
    }
    return Object.freeze({ kind: 'create' });
}

function buildPluginDisplayName(agent: EngineResolutionAgent, backend: EngineResolutionBackend): string {
    const richDisplayName = agent.richDefinition
        ? normalizeNonEmptyString(
            typeof agent.richDefinition.definition.title === 'string'
                ? agent.richDefinition.definition.title
                : agent.richDefinition.definition.title.fallback,
        )
        : null;
    if (richDisplayName) return richDisplayName;

    const agentTitle = normalizeNonEmptyString(agent.runtimeSpec?.title);
    if (agentTitle) return agentTitle;

    return normalizeNonEmptyString(backend.id) ?? normalizeNonEmptyString(agent.id) ?? 'Plugin Runtime';
}

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function createNativeAgentDeferredStartupConfig(params: Readonly<{
    backend: EngineResolutionBackend;
    agent: EngineResolutionAgent;
    displayName: string;
}>): Pick<HostSessionRuntimePlan['config'], 'startupBootstrap'> | Record<string, never> {
    const shouldUseDeferredSessionStartup =
        params.agent.catalogEntry?.shouldUseDeferredSessionStartup;
    if (!shouldUseDeferredSessionStartup) return {};

    const uiLogPrefix = `[${params.displayName}]`;
    const timingLogPrefix = `[${params.backend.id}-startup]`;
    const releasedCodexCache = resolveReleasedCodexStartupOverridesCacheV1Compatibility(
        params.backend.id,
    );
    let lastReleasedCacheWriteAt = 0;
    return {
        startupBootstrap: {
            ...(releasedCodexCache
                ? {
                    resolveSeed: ({
                        opts,
                        seed,
                    }: Readonly<{
                        opts: HostSessionRuntimeRunOptions;
                        seed: HostSessionRuntimeStartupSeed;
                    }>) => {
                        const providerResumeId = normalizeOptionalString(opts.resume);
                        if (!providerResumeId || typeof opts.permissionMode === 'string') return seed;
                        const cached = releasedCodexCache.read({
                            nowMs: Date.now(),
                            maxAgeMs: configuration.startupOverridesCacheMaxAgeMs,
                        });
                        if (!cached) return seed;
                        const agentTargetKey = opts.backendTarget
                            ? buildBackendTargetKeyV2(readBackendTargetRefV2(opts.backendTarget))
                            : buildBackendTargetKeyV2({
                                kind: 'backend',
                                backendId: params.backend.id,
                                sourceKind: 'built_in',
                            });
                        const cachedModelRef = cached.modelId
                            ? resolveSessionModelSelectionInputRefV1({
                                agentTargetKey,
                                providerConnectionId: null,
                                modelId: cached.modelId,
                            })
                            : null;
                        const currentProviderBoundModel =
                            seed.modelSelection?.ref.providerConnectionId !== null
                            && seed.modelSelection?.ref.providerConnectionId !== undefined
                                ? seed.modelSelection
                                : null;
                        return Object.freeze({
                            permissionMode: cached.permissionMode,
                            permissionModeUpdatedAt: cached.permissionModeUpdatedAt,
                            permissionModeSource: 'released_cache_v1',
                            modelSelection: currentProviderBoundModel
                                ? currentProviderBoundModel
                                : cachedModelRef
                                ? SessionModelSelectionV1Schema.parse({
                                    v: 1,
                                    updatedAt: cached.modelUpdatedAt,
                                    ref: cachedModelRef,
                                })
                                : seed.modelSelection,
                        });
                    },
                    writeRuntimeOverrides: (overrides: Readonly<{
                        permissionMode: PermissionMode;
                        permissionModeUpdatedAt: number;
                        modelSelection: SessionModelSelectionV1 | null;
                    }>) => {
                        lastReleasedCacheWriteAt = Math.max(
                            Date.now(),
                            lastReleasedCacheWriteAt + 1,
                        );
                        releasedCodexCache.write({
                            permissionMode: overrides.permissionMode,
                            permissionModeUpdatedAt: overrides.permissionModeUpdatedAt,
                            modelId: overrides.modelSelection?.ref.modelId ?? null,
                            modelUpdatedAt: overrides.modelSelection?.updatedAt ?? 0,
                            updatedAt: lastReleasedCacheWriteAt,
                        });
                    },
                }
                : {}),
            shouldCreate: ({ opts, seed }) => {
                if (seed.modelSelection?.ref.providerConnectionId) return false;
                return shouldUseDeferredSessionStartup({
                    startedBy: opts.startedBy === 'daemon' ? 'daemon' : 'terminal',
                    startingMode:
                        opts.startingMode === 'terminal'
                        || opts.startingMode === 'remote'
                        || opts.startingMode === 'local'
                            ? opts.startingMode
                            : null,
                    hasExistingSession: normalizeOptionalString(opts.existingSessionId) !== null,
                    hasSessionAttachFile: normalizeOptionalString(opts.sessionAttachFilePath) !== null,
                    hasProviderResumeId: normalizeOptionalString(opts.resume) !== null,
                    hasExplicitPermissionMode: typeof opts.permissionMode === 'string',
                    hasPersistedPermissionModeSeed:
                        seed.permissionModeSource === 'released_cache_v1',
                    hasTerminalTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
                });
            },
            create: async ({
                opts,
                seed,
                createPreparedDeferredStartupBootstrap,
            }: Readonly<{
                opts: HostSessionRuntimeRunOptions & Readonly<{
                    launchControlMetadata: NonNullable<HostSessionRuntimeRunOptions['launchControlMetadata']>;
                }>;
                seed: HostSessionRuntimeStartupSeed;
                createPreparedDeferredStartupBootstrap:
                    NonNullable<HostSessionRuntimePlan['config']['startupBootstrap']>['create'] extends (
                        params: infer TParams,
                    ) => unknown
                        ? TParams extends Readonly<{
                            createPreparedDeferredStartupBootstrap: infer TCreate;
                        }>
                            ? TCreate
                            : never
                        : never;
            }>) => {
                const initialMachineId = await readRequiredStartupMachineId();
                return await createPreparedDeferredStartupBootstrap({
                    credentials: opts.credentials,
                    flavor: params.backend.id,
                    workingDirectory: normalizeOptionalString(opts.directory) ?? process.cwd(),
                    startedBy: opts.startedBy === 'daemon' ? 'daemon' : 'terminal',
                    initialMachineId,
                    machineMetadata: initialMachineMetadata,
                    uiLogPrefix,
                    timingLogPrefix,
                    initialPermissionMode: seed.permissionMode,
                    explicitPermissionMode: seed.permissionMode,
                    explicitPermissionModeUpdatedAt: seed.permissionModeUpdatedAt,
                    sessionModeId: opts.sessionModeId,
                    sessionModeUpdatedAt: opts.sessionModeUpdatedAt,
                    modelSelection: seed.modelSelection ?? undefined,
                    terminalRuntime: opts.terminalRuntime ?? null,
                    launchControlMetadata: opts.launchControlMetadata,
                    existingSessionId: normalizeOptionalString(opts.existingSessionId) ?? undefined,
                    sessionAttachFilePath: normalizeOptionalString(opts.sessionAttachFilePath) ?? undefined,
                    startupSideEffectsOrder: 'persist-first',
                    onBackgroundStartFailure: () => {
                        logger.debug(`${timingLogPrefix} Deferred Session startup failed`);
                    },
                });
            },
        },
    };
}

type RegisteredExternalAgentIdentity = Readonly<{
    kind: 'registered_external_agent';
    pluginId: string;
    agentId: string;
}>;

function resolvePluginPolicyAgentId(params: Readonly<{
    backend: EngineResolutionBackend;
    agent: EngineResolutionAgent;
    registeredAgentIdentity?: RegisteredExternalAgentIdentity;
}>): string {
    if (params.backend.provenance === 'configured' || params.agent.provenance === 'configured') {
        throw new Error(
            `Host-configured Agent '${params.agent.id}' requires an explicit host policy identity`,
        );
    }
    const policyAgentId = resolveContributionCatalogAgentId({
        backend: params.backend,
        agent: params.agent,
    });
    if (policyAgentId) {
        return policyAgentId;
    }

    const registeredIdentity = params.registeredAgentIdentity;
    if (registeredIdentity) {
        if (normalizeBuiltInAgentId(registeredIdentity.agentId)) {
            throw new Error(
                `External Agent '${registeredIdentity.agentId}' from plugin '${registeredIdentity.pluginId}' collides with a built-in Agent id`,
            );
        }
        const declaredIds = [params.backend.id, params.backend.agentId, params.agent.id];
        if (declaredIds.some((id) => id !== registeredIdentity.agentId)) {
            throw new Error(
                `Registered external Agent '${registeredIdentity.agentId}' does not match its resolved Agent contribution identity`,
            );
        }
        if (
            params.backend.provenance !== 'external'
            || params.agent.provenance !== 'external'
            || params.agent.richDefinition?.provenance !== 'external'
            || params.backend.pluginId !== registeredIdentity.pluginId
            || params.agent.pluginId !== registeredIdentity.pluginId
        ) {
            throw new Error(
                `Registered external Agent '${registeredIdentity.agentId}' does not match its resolved plugin ownership`,
            );
        }
        // Host policy lookups accept string identities and fail closed for unknown
        // Agents. Preserve the current Agent's exact identity here; never grant it
        // another Agent's built-in policy through an implicit compatibility alias.
        return registeredIdentity.agentId;
    }

    throw new Error(
        `Plugin backend '${params.backend.id}' requires catalogAgentId to resolve to an exact built-in policy agent id before it can become a live session runtime`,
    );
}

export async function createNativeAgentHostSessionRuntimePlan(params: Readonly<{
    backend: EngineResolutionBackend;
    agent: EngineResolutionAgent;
    createSessionRuntime: NativeAgentSessionRuntimeCreate;
    sessionInput: PluginSessionBindingInput;
    registeredAgentIdentity?: RegisteredExternalAgentIdentity;
    /** Exact host policy identity for a non-plugin host-configured Agent runtime. */
    policyAgentId?: string;
    /** Host-owned Session projection for a non-plugin configured Agent runtime. */
    sessionProjection?: Readonly<{
        flavor: string;
        agentMessageType: HostSessionRuntimeConfig['agentMessageType'];
        augmentSessionMetadata?: HostSessionRuntimeConfig['augmentSessionMetadata'];
    }>;
    isMediatorPluginCurrent?: (pluginId: string) => boolean;
    isMediatorContributionCurrent?: HostSessionRuntimeConfig['isMediatorContributionCurrent'];
    agentSessionRealtimeVoiceAuthority?:
        HostSessionRuntimeConfig['agentSessionRealtimeVoiceAuthority'];
}>): Promise<HostSessionRuntimePlan> {
    const displayName = buildPluginDisplayName(params.agent, params.backend);
    const policyAgentId = params.policyAgentId ?? resolvePluginPolicyAgentId({
        backend: params.backend,
        agent: params.agent,
        ...(params.registeredAgentIdentity
            ? { registeredAgentIdentity: params.registeredAgentIdentity }
            : {}),
    });
    const TerminalDisplay = createProviderTerminalDisplay({
        title: displayName,
        footerName: displayName,
        accentColor: 'cyan',
    });
    const providerSessionMetadataKey = resolveNativeAgentVendorResumeIdField(policyAgentId);
    const augmentSessionMetadata: HostSessionRuntimeConfig['augmentSessionMetadata'] = (metadata) => {
        const projected = params.sessionProjection?.augmentSessionMetadata?.(metadata) ?? metadata;
        if (!params.registeredAgentIdentity) return projected;
        return applyRuntimeDescriptorSessionMetadata(projected, {
            v: 1,
            agentId: policyAgentId,
            agent: {},
        });
    };

    return createCatalogHostSessionRuntimePlan({
        agentId: params.backend.id,
        opts: buildPluginHostSessionRuntimeOptions(params.sessionInput),
        config: createCatalogHostSessionRuntimeConfig<PluginRuntimeHookOperations>({
            agentId: params.backend.id,
            config: {
                displayName,
                flavor: params.sessionProjection?.flavor ?? params.backend.id,
                ...(params.sessionProjection
                    ? {
                        agentMessageType: params.sessionProjection.agentMessageType,
                    }
                    : {}),
                ...(params.registeredAgentIdentity || params.sessionProjection?.augmentSessionMetadata
                    ? { augmentSessionMetadata }
                    : {}),
                policyAgentId,
                providerRequirements:
                    params.agent.richDefinition?.definition
                        .providerRequirements,
                ...(params.agentSessionRealtimeVoiceAuthority
                    ? {
                        agentSessionRealtimeVoiceAuthority:
                            params.agentSessionRealtimeVoiceAuthority,
                    }
                    : {}),
                ...(params.isMediatorPluginCurrent
                    ? { isMediatorPluginCurrent: params.isMediatorPluginCurrent }
                    : {}),
                ...(params.isMediatorContributionCurrent
                    ? { isMediatorContributionCurrent: params.isMediatorContributionCurrent }
                    : {}),
                ...createNativeAgentDeferredStartupConfig({
                    backend: params.backend,
                    agent: params.agent,
                    displayName,
                }),
                ...(params.agent.catalogEntry?.runtimeActivityApplicability !== undefined
                    ? { runtimeActivityApplicability: params.agent.catalogEntry.runtimeActivityApplicability }
                    : {}),
                terminalDisplay: TerminalDisplay,
                formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
                ...(providerSessionMetadataKey ? { providerSessionMetadataKey } : {}),
                createNativeRuntime: async (runtimeParams) => {
                    const initialRuntime = await normalizeNativeAgentSessionRuntimeCreation(
                        await params.createSessionRuntime(
                            resolveInitialNativeAgentSessionOpenIntent(
                                params.sessionInput,
                                runtimeParams.strictNativeResumeIdentity === true,
                            ),
                            runtimeParams,
                        ),
                    );
                    const operations = bindReplaceableNativeAgentSessionOperations({
                        initialRuntime,
                        recreateOperations: async (intent) => {
                            return normalizeNativeAgentSessionRuntimeCreation(
                                await params.createSessionRuntime(
                                    intent.kind === 'resume'
                                        ? Object.freeze({
                                            kind: 'resume',
                                            providerSessionId: intent.providerSessionId,
                                            importHistory: intent.importHistory,
                                            ...(intent.startupInstructions !== undefined ? { startupInstructions: intent.startupInstructions } : {}),
                                        })
                                        : Object.freeze({ kind: 'create',
                                            ...(intent.startupInstructions !== undefined ? { startupInstructions: intent.startupInstructions } : {}),
                                        }),
                                    runtimeParams,
                                ),
                            );
                        },
                    });
                    return {
                        operations,
                        nativeRuntime: operations,
                        ...(initialRuntime.configuration
                            ? { configuration: initialRuntime.configuration }
                            : {}),
                        ...(initialRuntime.runtimeCapabilities
                            ? { runtimeCapabilities: initialRuntime.runtimeCapabilities }
                            : {}),
                        ...(initialRuntime.admittedProviderBindingHandoff
                            ? {
                                admittedProviderBindingHandoff:
                                    initialRuntime.admittedProviderBindingHandoff,
                            }
                            : {}),
                    } satisfies HostSessionRuntimeFactoryResult<
                        PluginRuntimeHookOperations
                    >;
                },
            },
        }),
    });
}
