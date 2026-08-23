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
    ResolvedAgentRuntimeContribution,
    ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';
import { createProviderTerminalDisplay } from '@/ui/providers/providerTerminalDisplay';
import {
    getAgentResumeConfig,
    resolveModelSelectionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import {
    buildBackendTargetKeyV2,
    buildUnsupportedSessionPendingInputInterruptAndRunResult,
    buildUnsupportedSessionTerminalComposerClearResult,
    readBackendTargetRefV2,
    readPendingLocalId,
    SessionModelSelectionResolutionError,
    SessionModelSelectionV1Schema,
    resolveSessionModelSelectionInputRefV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type {
  AgentSessionHostServices,
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { NativeForkSource } from '@/session/shared/spawnSessionContract';
import type { ProviderBindingLaunchHandoffV1 } from '@/plugins/runtime/providerBindings/handoff';
import { logger } from '@/ui/logger';
import {
    readReleasedStartupOverridesCacheV1,
    writeReleasedStartupOverridesCacheV1,
} from '@/agent/runtime/startup/releasedStartupOverridesCacheV1';
import { configuration } from '@/configuration';
import type { PermissionMode } from '@/api/types';

import {
    decorateRuntimeTurnOperationsWithMetadata,
    normalizePluginSessionLaunchResult,
} from './sessionMetadata';
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
    type PluginSessionLaunchHandler,
    buildPluginSessionLaunchParams,
} from './sessionLaunch';

type NativeAgentSessionOpenIntent =
    | Readonly<{ kind: 'create' }>
    | Readonly<{
        kind: 'resume';
        providerSessionId: string;
        importHistory: boolean;
        strictNativeResumeIdentity?: boolean;
    }>
    | Readonly<{ kind: 'fork'; source: NativeForkSource }>;

type NativeAgentSessionRuntimeCreation = Readonly<{
    operations: PluginRuntimeHookOperations;
    admittedProviderBindingHandoff?: ProviderBindingLaunchHandoffV1 | null;
}>;

type NativeAgentSessionRuntimeCreate = (
    intent: NativeAgentSessionOpenIntent,
    hostRuntime: HostSessionRuntimeFactoryParams,
) => PluginRuntimeHookOperations
    | NativeAgentSessionRuntimeCreation
    | Promise<PluginRuntimeHookOperations | NativeAgentSessionRuntimeCreation>;

function normalizeNativeAgentSessionRuntimeCreation(
    created: PluginRuntimeHookOperations | NativeAgentSessionRuntimeCreation,
): NativeAgentSessionRuntimeCreation {
    if ('operations' in created) return created;
    return { operations: created };
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
 * flat key and the session-state binding routes it to the agent-agnostic
 * runtime-descriptor slot, which is what the resume readers consult.
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
    let runtimeClosed = false;
    let runtimeBindingEpoch = 0;
    let stableRuntimeOperations: PluginRuntimeHookOperations | null = null;
    let replacementLifecycle: HostRuntimeReplacementLifecycle | null = null;
    const runtimeEventHandlers = new Set<RuntimeTurnMessageHandler>();
    let runtimeEventUnsubscribe: (() => void) | null = null;
    let promptAcceptedHandler: PluginRuntimePromptAcceptedHandler | null = null;
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
        currentOperations.setOnPromptAcceptedByProvider?.(promptAcceptedHandler
            ? (info) => {
                if (runtimeClosed || bindingEpoch !== runtimeBindingEpoch) return;
                promptAcceptedHandler?.(info);
            }
            : null);
        currentOperations.setOnPromptDeliveryOutcome?.(promptDeliveryOutcomeHandler
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
        if (promptAcceptedHandler && !currentOperations.setOnPromptAcceptedByProvider) {
            throw new Error('Recreated plugin session runtime dropped its provider-acceptance seam after the host registered a provider-acceptance handler');
        }
        if (promptDeliveryOutcomeHandler && !currentOperations.setOnPromptDeliveryOutcome) {
            throw new Error('Recreated plugin session runtime dropped its prompt-delivery-outcome seam after the host registered a prompt-delivery-outcome handler');
        }
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
            await currentOperations.steerPrompt?.(message, options);
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
        ...(currentOperations.setOnPromptAcceptedByProvider
            ? {
                setOnPromptAcceptedByProvider(handler: PluginRuntimePromptAcceptedHandler | null) {
                    promptAcceptedHandler = handler;
                    bindProviderInputHandlersToCurrentRuntime();
                },
            }
            : {}),
        ...(currentOperations.setOnPromptDeliveryOutcome
            ? {
                setOnPromptDeliveryOutcome(handler: ((outcome: PluginRuntimePromptDeliveryOutcome) => void) | null) {
                    promptDeliveryOutcomeHandler = handler;
                    bindProviderInputHandlersToCurrentRuntime();
                },
            }
            : {}),
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
        readSessionIdentity() {
            return currentOperations.readSessionIdentity();
        },
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
    const providerSessionId = normalizeNonEmptyString(sessionInput.resume.resumeSessionId);
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

function buildPluginDisplayName(agent: ResolvedAgentContribution, backend: ResolvedAgentRuntimeContribution): string {
    const agentTitle = normalizeNonEmptyString(agent.runtimeSpec?.title);
    if (agentTitle) return agentTitle;

    const richDisplayName = agent.richDefinition?.provenance === 'external'
        ? normalizeNonEmptyString(
            typeof agent.richDefinition.definition.title === 'string'
                ? agent.richDefinition.definition.title
                : agent.richDefinition.definition.title.fallback,
        )
        : null;
    if (richDisplayName) return richDisplayName;

    return normalizeNonEmptyString(backend.id) ?? normalizeNonEmptyString(agent.id) ?? 'Plugin Runtime';
}

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function createNativeAgentDeferredStartupConfig(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    displayName: string;
}>): Pick<HostSessionRuntimePlan['config'], 'startupBootstrap'> | Record<string, never> {
    const shouldUseDeferredSessionStartup =
        params.agent.catalogEntry?.shouldUseDeferredSessionStartup;
    if (!shouldUseDeferredSessionStartup) return {};

    const uiLogPrefix = `[${params.displayName}]`;
    const timingLogPrefix = `[${params.backend.id}-startup]`;
    const releasedCachePolicy = params.agent.catalogEntry?.releasedStartupOverridesCacheV1;
    let lastReleasedCacheWriteAt = 0;
    return {
        startupBootstrap: {
            ...(releasedCachePolicy
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
                        const cached = readReleasedStartupOverridesCacheV1({
                            backendId: params.backend.id,
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
                        writeReleasedStartupOverridesCacheV1({
                            backendId: params.backend.id,
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
                    existingSessionId: normalizeOptionalString(opts.existingSessionId),
                    sessionAttachFilePath: normalizeOptionalString(opts.sessionAttachFilePath),
                    providerResumeId: normalizeOptionalString(opts.resume),
                    hasExplicitPermissionMode: typeof opts.permissionMode === 'string',
                    permissionModeSeedSource: seed.permissionModeSource,
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
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    registeredAgentIdentity?: RegisteredExternalAgentIdentity;
}>): string {
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

export async function createPluginSessionRuntimePlan(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    launch: PluginSessionLaunchHandler;
    sessionInput: PluginSessionBindingInput;
}>): Promise<HostSessionRuntimePlan> {
    const displayName = buildPluginDisplayName(params.agent, params.backend);
    const policyAgentId = resolvePluginPolicyAgentId({
        backend: params.backend,
        agent: params.agent,
    });
    const TerminalDisplay = createProviderTerminalDisplay({
        title: displayName,
        footerName: displayName,
        accentColor: 'cyan',
    });

    return createCatalogHostSessionRuntimePlan({
        agentId: params.backend.id,
        opts: buildPluginHostSessionRuntimeOptions(params.sessionInput),
        config: createCatalogHostSessionRuntimeConfig({
            agentId: params.backend.id,
            config: {
                displayName,
                flavor: params.backend.id,
                policyAgentId,
                providerRequirements:
                    params.agent.richDefinition?.definition
                        .providerRequirements,
                ...(params.agent.catalogEntry?.runtimeActivityApplicability !== undefined
                    ? { runtimeActivityApplicability: params.agent.catalogEntry.runtimeActivityApplicability }
                    : {}),
                terminalDisplay: TerminalDisplay,
                formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
                createNativeRuntime: async (runtimeParams) => {
                    const sessionLaunchParams = buildPluginSessionLaunchParams({
                        backend: params.backend,
                        agent: params.agent,
                        input: params.sessionInput,
                        runtime: {
                            sessionId: runtimeParams.session.sessionId,
                            directory: runtimeParams.directory,
                            metadata: runtimeParams.metadata,
                        },
                    });
                    const launchResult = await params.launch(sessionLaunchParams);
                    const normalized = normalizePluginSessionLaunchResult({
                        result: launchResult,
                        backend: params.backend,
                    });
                    return decorateRuntimeTurnOperationsWithMetadata(normalized);
                },
            },
        }),
    });
}

export async function createNativeAgentHostSessionRuntimePlan(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    createSessionRuntime: NativeAgentSessionRuntimeCreate;
    sessionInput: PluginSessionBindingInput;
    registeredAgentIdentity?: RegisteredExternalAgentIdentity;
    isMediatorPluginCurrent?: (pluginId: string) => boolean;
    isMediatorContributionCurrent?: HostSessionRuntimeConfig['isMediatorContributionCurrent'];
    agentSessionRealtimeVoiceAuthority?:
        HostSessionRuntimeConfig['agentSessionRealtimeVoiceAuthority'];
}>): Promise<HostSessionRuntimePlan> {
    const displayName = buildPluginDisplayName(params.agent, params.backend);
    const policyAgentId = resolvePluginPolicyAgentId({
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

    return createCatalogHostSessionRuntimePlan({
        agentId: params.backend.id,
        opts: buildPluginHostSessionRuntimeOptions(params.sessionInput),
        config: createCatalogHostSessionRuntimeConfig({
            agentId: params.backend.id,
            config: {
                displayName,
                flavor: params.backend.id,
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
                    const initialRuntime = normalizeNativeAgentSessionRuntimeCreation(
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
                                        })
                                        : Object.freeze({ kind: 'create' }),
                                    runtimeParams,
                                ),
                            );
                        },
                    });
                    return {
                        operations,
                        nativeRuntime: operations,
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
