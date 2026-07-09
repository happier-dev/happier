import {
    createCatalogHostSessionRuntimeConfig,
    createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/catalogPlan';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type {
    RuntimeTurnCompletionOptions,
    RuntimeTurnConfigUpdate,
    RuntimeTurnMessage,
    RuntimeTurnMessageHandler,
    RuntimeTurnSessionIdentity,
    RuntimeTurnStartOrLoadOptions,
    RuntimeTurnPromptMeta,
    RuntimeConfigUpdateOutcomeV1,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    createRuntimeTurnFailureAlreadySurfacedError,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { resolveContributionProviderAgentId } from '@/plugins/projection/registry/resolveContributionProviderAgentId';
import type {
    ResolvedAgentRuntimeContribution,
    ResolvedAgentContribution,
} from '@/plugins/projection/registry/types';
import { createProviderTerminalDisplay } from '@/ui/providers/providerTerminalDisplay';
import type { AgentId } from '@happier-dev/agents';
import {
    buildUnsupportedSessionTerminalComposerClearResult,
    type RuntimeEventV1,
} from '@happier-dev/protocol';
import type {
    CreateSessionRuntimeParamsV1,
    RuntimeCancelResultV1,
    RuntimeDisposeReasonV1,
    RuntimeSendOptionsV1,
    RuntimeSendResultV1,
    SessionRuntimeConfigUpdateV1,
    SessionRuntimeMcpServerConfigV1,
    SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';

import {
    decorateRuntimeTurnOperationsWithMetadata,
    normalizePluginSessionLaunchResult,
} from './sessionMetadata';
import type {
    PluginRuntimeApplyConfigDeltaInFlight,
    PluginRuntimeClearTerminalComposer,
    PluginRuntimeHookOperations,
    PluginRuntimePromptAcceptedHandler,
    PluginRuntimeUndeliverablePrompt,
} from './sessionRuntimeHooks';
import {
    buildPluginHostSessionRuntimeOptions,
    type PluginSessionBindingInput,
    type PluginSessionLaunchHandler,
    buildPluginSessionLaunchParams,
} from './sessionLaunch';

type PublicSessionRuntimeCreate = (
    params: CreateSessionRuntimeParamsV1 & Readonly<Record<string, unknown>>,
) => SessionRuntimeV1 | Promise<SessionRuntimeV1>;

type PublicRuntimeStartOrLoadSession = (opts?: RuntimeTurnStartOrLoadOptions) => Promise<unknown> | unknown;
type PublicRuntimeBeginTurnLifecycle = () => void;
type PublicRuntimeWaitForTurnCompletion = (opts?: RuntimeTurnCompletionOptions) => Promise<void> | void;
type PublicRuntimeCancelTurn = () => Promise<void> | void;
type PublicRuntimeReadSessionIdentity = () => RuntimeTurnSessionIdentity;
type PublicRuntimeUpdateSessionRuntimeConfig = (
    update: SessionRuntimeConfigUpdateV1 & Readonly<Record<string, unknown>>,
) => Promise<RuntimeConfigUpdateOutcomeV1 | void> | RuntimeConfigUpdateOutcomeV1 | void;
type PublicRuntimeResetOrDisposeRuntime = (
    reason?: RuntimeDisposeReasonV1 | Readonly<{ reason?: RuntimeDisposeReasonV1 }>,
) => Promise<void> | void;
type PublicRuntimePromptAcceptedHandler = (info: Readonly<{
    localInputId?: string | null;
    localInputIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>) => void;
type PublicRuntimePromptTerminallyRejectedBeforeProviderHandler = (
    info: Readonly<{
        localInputId?: string | null;
        localInputIds?: readonly string[];
        userMessageSeq: number | null;
        userMessageSeqs?: readonly number[];
    }>,
) => void;
type PublicRuntimeUndeliverablePrompt = Readonly<{
    text: string;
    localInputId?: string | null;
    localInputIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;
type PublicRuntimeSetPromptAcceptedByProvider = (handler: PublicRuntimePromptAcceptedHandler | null) => void;
type PublicRuntimeSetPromptTerminallyRejectedBeforeProvider = (
    handler: PublicRuntimePromptTerminallyRejectedBeforeProviderHandler | null,
) => void;
type PublicRuntimeSetUndeliverablePrompts = (
    handler: ((prompts: ReadonlyArray<PublicRuntimeUndeliverablePrompt>) => void) | null,
) => void;
type PublicRuntimeSupportsInFlightSteer = () => boolean;
type PublicRuntimeIsTurnInFlight = () => boolean;
type PublicRuntimeCanSteerPrompt = () => boolean;

type PublicRuntimeTerminalEvent = Extract<
    RuntimeEventV1,
    { kind: 'turn-complete' | 'turn-cancelled' | 'turn-failed' }
>;
type PublicRuntimeTurnStartEvent = Extract<RuntimeEventV1, { kind: 'turn-start' }>;

type PublicRuntimeBridgeCompletion = Readonly<{
    isSettled: () => boolean;
    noteTurnStart: (event: PublicRuntimeTurnStartEvent) => void;
    settle: (event?: PublicRuntimeTerminalEvent) => void;
    settleTerminalEvent: (event: PublicRuntimeTerminalEvent) => void;
    fail: (error: Error) => void;
    throwIfFailed: () => void;
    wait: (opts?: RuntimeTurnCompletionOptions) => Promise<void>;
}>;

const DEFAULT_PUBLIC_RUNTIME_TURN_COMPLETION_TIMEOUT_MS = 30 * 60_000;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRuntimeExtraFunction<TFunction extends (...args: never[]) => unknown>(
    runtime: SessionRuntimeV1,
    key: string,
): TFunction | null {
    const candidate = (runtime as Readonly<Record<string, unknown>>)[key];
    return typeof candidate === 'function' ? candidate as TFunction : null;
}

function createRuntimeInput(prompt: string): Readonly<{ v: 1; text: string }> {
    return { v: 1, text: prompt };
}

function assertRuntimeSendAccepted(result: RuntimeSendResultV1): void {
    if (result.status === 'accepted') return;
    const diagnostic = result.diagnostic ? `: ${result.diagnostic}` : '';
    throw new Error(`Plugin session runtime rejected prompt with status '${result.status}'${diagnostic}`);
}

function normalizePublicConfigUpdate(update: RuntimeTurnConfigUpdate): SessionRuntimeConfigUpdateV1 {
    return Object.freeze({
        ...(typeof update.modeId === 'string' ? { modeId: update.modeId } : {}),
        ...(typeof update.modelId === 'string' ? { modelId: update.modelId } : {}),
        ...(typeof update.permissionMode === 'string' ? { permissionMode: update.permissionMode } : {}),
        ...(update.configOption ? { configOption: update.configOption } : {}),
    });
}

function readPublicRuntimeIdentity(runtime: SessionRuntimeV1): RuntimeTurnSessionIdentity {
    return {
        sessionId: normalizeNonEmptyString(runtime.identity.read().providerSessionId),
    };
}

async function dispatchPublicRuntimePrompt(
    runtime: SessionRuntimeV1,
    prompt: string,
    options?: RuntimeSendOptionsV1,
): Promise<RuntimeSendResultV1> {
    const result = await runtime.send(createRuntimeInput(prompt), options);
    assertRuntimeSendAccepted(result);
    return result;
}

function isPublicRuntimeTerminalEvent(message: RuntimeTurnMessage): message is Extract<
    RuntimeEventV1,
    { kind: 'turn-complete' | 'turn-cancelled' | 'turn-failed' }
> {
    if (!('kind' in message)) return false;
    return message.kind === 'turn-complete'
        || message.kind === 'turn-cancelled'
        || message.kind === 'turn-failed';
}

function isPublicRuntimeTurnStartEvent(message: RuntimeTurnMessage): message is PublicRuntimeTurnStartEvent {
    if (!('kind' in message)) return false;
    return message.kind === 'turn-start';
}

function normalizeWaitTimeoutMs(opts?: RuntimeTurnCompletionOptions): number | null {
    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs === null || timeoutMs === undefined) return null;
    if (!Number.isFinite(timeoutMs)) return null;
    return Math.max(0, Math.trunc(timeoutMs));
}

function resolvePublicRuntimeBridgeWaitTimeoutMs(opts?: RuntimeTurnCompletionOptions): number | null {
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'timeoutMs') && opts.timeoutMs === null) {
        return null;
    }
    return normalizeWaitTimeoutMs(opts) ?? DEFAULT_PUBLIC_RUNTIME_TURN_COMPLETION_TIMEOUT_MS;
}

function publicRuntimeWaitOptionsWithDefault(opts?: RuntimeTurnCompletionOptions): RuntimeTurnCompletionOptions {
    const timeoutMs = resolvePublicRuntimeBridgeWaitTimeoutMs(opts);
    return {
        ...(opts ?? {}),
        timeoutMs,
    };
}

function errorFromUnknown(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(String(error));
}

function createPublicRuntimeTerminalFailureError(event: PublicRuntimeTerminalEvent | undefined): Error | null {
    if (event?.kind !== 'turn-failed') return null;
    const preview = typeof event.issue.sanitizedPreview === 'string'
        ? event.issue.sanitizedPreview.trim()
        : '';
    const suffix = preview.length > 0 ? `: ${preview}` : '';
    return createRuntimeTurnFailureAlreadySurfacedError({
        message: `Plugin session runtime turn failed${suffix}`,
        event,
    });
}

function createPublicRuntimeBridgeCompletion(params?: Readonly<{
    onTimeoutTurnIds?: (turnIds: readonly string[]) => void;
}>): PublicRuntimeBridgeCompletion {
    let settled = false;
    let settledError: Error | null = null;
    const observedTurnIds = new Set<string>();
    const waiters = new Set<{
        resolve: () => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout | null;
    }>();

    const complete = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        settledError = error;
        for (const waiter of Array.from(waiters)) {
            if (waiter.timer) clearTimeout(waiter.timer);
            if (settledError) {
                waiter.reject(settledError);
            } else {
                waiter.resolve();
            }
        }
        waiters.clear();
    };

    const fail = (error: Error): void => {
        complete(error);
    };

    const settle = (event?: PublicRuntimeTerminalEvent): void => {
        complete(createPublicRuntimeTerminalFailureError(event));
    };

    return Object.freeze({
        isSettled: () => settled,
        noteTurnStart: (event: PublicRuntimeTurnStartEvent) => {
            if (settled) return;
            const turnId = normalizeNonEmptyString(event.turnId);
            if (turnId) observedTurnIds.add(turnId);
        },
        settle,
        settleTerminalEvent: (event: PublicRuntimeTerminalEvent) => {
            if (settled) return;
            const turnId = normalizeNonEmptyString(event.turnId);
            if (observedTurnIds.size > 0 && (!turnId || !observedTurnIds.has(turnId))) return;
            settle(event);
        },
        fail,
        throwIfFailed: () => {
            if (settledError) throw settledError;
        },
        wait: async (opts?: RuntimeTurnCompletionOptions): Promise<void> => {
            if (settled) {
                if (settledError) throw settledError;
                return;
            }
            const timeoutMs = resolvePublicRuntimeBridgeWaitTimeoutMs(opts);
            await new Promise<void>((resolve, reject) => {
                const waiter = {
                    resolve: () => {
                        waiters.delete(waiter);
                        resolve();
                    },
                    reject: (error: Error) => {
                        waiters.delete(waiter);
                        reject(error);
                    },
                    timer: null as NodeJS.Timeout | null,
                };
                waiters.add(waiter);
                if (timeoutMs !== null) {
                    waiter.timer = setTimeout(() => {
                        if (observedTurnIds.size > 0) {
                            params?.onTimeoutTurnIds?.([...observedTurnIds]);
                        }
                        fail(new Error(`Plugin session runtime turn did not complete within ${timeoutMs}ms`));
                    }, timeoutMs);
                    waiter.timer.unref?.();
                }
            });
        },
    });
}

function normalizeNonEmptyStringList(values: readonly unknown[] | null | undefined): string[] {
    const normalized: string[] = [];
    for (const value of values ?? []) {
        const text = normalizeNonEmptyString(value);
        if (!text || normalized.includes(text)) continue;
        normalized.push(text);
    }
    return normalized;
}

function normalizeSeqList(values: readonly unknown[] | null | undefined): number[] {
    const normalized: number[] = [];
    for (const value of values ?? []) {
        if (!Number.isSafeInteger(value) || (value as number) < 0) continue;
        if (normalized.includes(value as number)) continue;
        normalized.push(value as number);
    }
    return normalized;
}

function runtimeSendOptionsForTurnMeta(meta?: Readonly<{
    localId?: string | null;
    localIds?: readonly string[];
    modelId?: string | null;
    providerClaimedPendingLocalIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
}>): RuntimeSendOptionsV1 | undefined {
    const localInputId = normalizeNonEmptyString(meta?.localId);
    const localInputIds = normalizeNonEmptyStringList([
        ...(localInputId ? [localInputId] : []),
        ...(meta?.localIds ?? []),
    ]);
    const modelId = normalizeNonEmptyString(meta?.modelId);
    const providerClaimedPendingLocalIds = normalizeNonEmptyStringList(meta?.providerClaimedPendingLocalIds);
    const userMessageSeq = meta?.userMessageSeq;
    const userMessageSeqs = normalizeSeqList([
        ...(typeof userMessageSeq === 'number' && Number.isFinite(userMessageSeq) ? [Math.trunc(userMessageSeq)] : []),
        ...(meta?.userMessageSeqs ?? []),
    ]);
    const result: RuntimeSendOptionsV1 = {
        ...(localInputId ? { localInputId } : {}),
        ...(localInputIds.length > 0 ? { localInputIds } : {}),
        ...(modelId ? { modelId } : {}),
        ...(providerClaimedPendingLocalIds.length > 0 ? { providerClaimedPendingLocalIds } : {}),
        ...(typeof userMessageSeq === 'number' && Number.isFinite(userMessageSeq)
            ? { userMessageSeq: Math.trunc(userMessageSeq) }
            : {}),
        ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
    };
    return Object.keys(result).length > 0 ? result : undefined;
}

function runtimeSendOptionsForSteer(
    options?: Readonly<{
        localId?: string | null;
        localIds?: readonly string[];
        modelId?: string | null;
        providerClaimedPendingLocalIds?: readonly string[];
        userMessageSeq?: number | null;
        userMessageSeqs?: readonly number[];
    }>,
): RuntimeSendOptionsV1 {
    const localInputId = normalizeNonEmptyString(options?.localId);
    const localInputIds = normalizeNonEmptyStringList([
        ...(localInputId ? [localInputId] : []),
        ...(options?.localIds ?? []),
    ]);
    const modelId = normalizeNonEmptyString(options?.modelId);
    const providerClaimedPendingLocalIds = normalizeNonEmptyStringList(options?.providerClaimedPendingLocalIds);
    const userMessageSeq = options?.userMessageSeq;
    const userMessageSeqs = normalizeSeqList([
        ...(typeof userMessageSeq === 'number' && Number.isFinite(userMessageSeq) ? [Math.trunc(userMessageSeq)] : []),
        ...(options?.userMessageSeqs ?? []),
    ]);
    return {
        deliverAs: 'steer',
        ...(localInputId ? { localInputId } : {}),
        ...(localInputIds.length > 0 ? { localInputIds } : {}),
        ...(modelId ? { modelId } : {}),
        ...(providerClaimedPendingLocalIds.length > 0 ? { providerClaimedPendingLocalIds } : {}),
        ...(typeof userMessageSeq === 'number' && Number.isFinite(userMessageSeq)
            ? { userMessageSeq: Math.trunc(userMessageSeq) }
            : {}),
        ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
    };
}

function publicAcceptedInfoToInternal(info: Parameters<PublicRuntimePromptAcceptedHandler>[0]): Readonly<{
    localIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}> {
    const localInputId = normalizeNonEmptyString(info.localInputId);
    const localIds = normalizeNonEmptyStringList([
        ...(localInputId ? [localInputId] : []),
        ...(info.localInputIds ?? []),
    ]);
    const userMessageSeqs = normalizeSeqList([
        ...(typeof info.userMessageSeq === 'number' && Number.isFinite(info.userMessageSeq)
            ? [Math.trunc(info.userMessageSeq)]
            : []),
        ...(info.userMessageSeqs ?? []),
    ]);
    return {
        userMessageSeq: typeof info.userMessageSeq === 'number' && Number.isFinite(info.userMessageSeq)
            ? Math.trunc(info.userMessageSeq)
            : null,
        ...(localIds.length > 0 ? { localIds } : {}),
        ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
    };
}

function clonePublicSessionMcpServers(
    mcpServers: HostSessionRuntimeFactoryParams['mcpServers'],
): Readonly<Record<string, SessionRuntimeMcpServerConfigV1>> {
    const entries = Object.entries(mcpServers);
    if (entries.length === 0) return Object.freeze({});
    const cloned: Record<string, SessionRuntimeMcpServerConfigV1> = {};
    for (const [name, config] of entries) {
        cloned[name] = Object.freeze({
            ...config,
            ...(config.env ? { env: Object.freeze({ ...config.env }) } : {}),
            ...(config.args ? { args: Object.freeze([...config.args]) } : {}),
        });
    }
    return Object.freeze(cloned);
}

function adaptSinglePublicSessionRuntimeToTurnOperations(runtime: SessionRuntimeV1): PluginRuntimeHookOperations {
    const beginTurnLifecycle = readRuntimeExtraFunction<PublicRuntimeBeginTurnLifecycle>(
        runtime,
        'beginTurnLifecycle',
    );
    const startOrLoadSession = readRuntimeExtraFunction<PublicRuntimeStartOrLoadSession>(
        runtime,
        'startOrLoadSession',
    );
    const waitForTurnCompletion = readRuntimeExtraFunction<PublicRuntimeWaitForTurnCompletion>(
        runtime,
        'waitForTurnCompletion',
    );
    const cancelTurn = readRuntimeExtraFunction<PublicRuntimeCancelTurn>(
        runtime,
        'cancelTurn',
    );
    const readSessionIdentity = readRuntimeExtraFunction<PublicRuntimeReadSessionIdentity>(
        runtime,
        'readSessionIdentity',
    );
    const updateSessionRuntimeConfig = readRuntimeExtraFunction<PublicRuntimeUpdateSessionRuntimeConfig>(
        runtime,
        'updateSessionRuntimeConfig',
    );
    const resetOrDisposeRuntime = readRuntimeExtraFunction<PublicRuntimeResetOrDisposeRuntime>(
        runtime,
        'resetOrDisposeRuntime',
    );
    const supportsInFlightSteer = readRuntimeExtraFunction<PublicRuntimeSupportsInFlightSteer>(
        runtime,
        'supportsInFlightSteer',
    );
    const isTurnInFlight = readRuntimeExtraFunction<PublicRuntimeIsTurnInFlight>(
        runtime,
        'isTurnInFlight',
    );
    const canSteerPrompt = readRuntimeExtraFunction<PublicRuntimeCanSteerPrompt>(
        runtime,
        'canSteerPrompt',
    );
    const applyConfigDeltaInFlight = readRuntimeExtraFunction<PluginRuntimeApplyConfigDeltaInFlight>(
        runtime,
        'applyConfigDeltaInFlight',
    );
    const setOnPromptAcceptedByProvider = readRuntimeExtraFunction<PublicRuntimeSetPromptAcceptedByProvider>(
        runtime,
        'setOnPromptAcceptedByProvider',
    );
    const setOnPromptTerminallyRejectedBeforeProvider = readRuntimeExtraFunction<PublicRuntimeSetPromptTerminallyRejectedBeforeProvider>(
        runtime,
        'setOnPromptTerminallyRejectedBeforeProvider',
    );
    const setOnUndeliverablePrompts = readRuntimeExtraFunction<PublicRuntimeSetUndeliverablePrompts>(
        runtime,
        'setOnUndeliverablePrompts',
    );
    const clearTerminalComposer = readRuntimeExtraFunction<PluginRuntimeClearTerminalComposer>(
        runtime,
        'clearTerminalComposer',
    );
    const permissions = runtime.permissions;
    let currentPrompt: Promise<RuntimeSendResultV1> | null = null;
    let currentCompletion: PublicRuntimeBridgeCompletion | null = null;
    const timedOutTurnIds = new Set<string>();

    const ensureBridgeCompletion = (): PublicRuntimeBridgeCompletion => {
        if (!currentCompletion || currentCompletion.isSettled()) {
            currentCompletion = createPublicRuntimeBridgeCompletion({
                onTimeoutTurnIds: (turnIds) => {
                    for (const turnId of turnIds) timedOutTurnIds.add(turnId);
                },
            });
        }
        return currentCompletion;
    };

    const runtimeEventUnsubscribe = runtime.events.subscribe((event) => {
        if (isPublicRuntimeTurnStartEvent(event)) {
            currentCompletion?.noteTurnStart(event);
            return;
        }
        if (isPublicRuntimeTerminalEvent(event)) {
            const turnId = normalizeNonEmptyString(event.turnId);
            if (turnId && timedOutTurnIds.delete(turnId)) return;
            currentCompletion?.settleTerminalEvent(event);
        }
    });

    async function waitForSubmittedPrompt(): Promise<void> {
        const promptWork = currentPrompt;
        if (!promptWork) return;
        try {
            await promptWork;
        } finally {
            if (currentPrompt === promptWork) currentPrompt = null;
        }
    }

    async function submitPrompt(prompt: string, options?: RuntimeSendOptionsV1): Promise<void> {
        ensureBridgeCompletion();
        const promptWork = dispatchPublicRuntimePrompt(runtime, prompt, options);
        currentPrompt = promptWork;
        try {
            await promptWork;
        } catch (error) {
            if (currentPrompt === promptWork) currentPrompt = null;
            currentCompletion?.settle();
            throw error;
        }
    }

    return Object.freeze({
        ...(permissions?.capability ? { permissionCapability: permissions.capability } : {}),
        beginTurnLifecycle() {
            ensureBridgeCompletion();
            beginTurnLifecycle?.();
        },
        async startOrLoadSession(opts?: RuntimeTurnStartOrLoadOptions) {
            if (startOrLoadSession) {
                return await startOrLoadSession(opts);
            }
            return readPublicRuntimeIdentity(runtime).sessionId;
        },
        async sendTurnPrompt(prompt: string, meta?: RuntimeTurnPromptMeta) {
            await submitPrompt(prompt, runtimeSendOptionsForTurnMeta(meta));
        },
        async steerInFlightTurn(message: string, meta?: RuntimeTurnPromptMeta) {
            await submitPrompt(message, runtimeSendOptionsForSteer(meta));
        },
        async steerPrompt(message, options) {
            await submitPrompt(message, runtimeSendOptionsForSteer(options));
        },
        ...(supportsInFlightSteer ? { supportsInFlightSteer: () => supportsInFlightSteer() } : {}),
        ...(isTurnInFlight ? { isTurnInFlight: () => isTurnInFlight() } : {}),
        ...(canSteerPrompt ? { canSteerPrompt: () => canSteerPrompt() } : {}),
        ...(applyConfigDeltaInFlight
            ? {
                applyConfigDeltaInFlight: (
                    delta: Parameters<PluginRuntimeApplyConfigDeltaInFlight>[0],
                ) => applyConfigDeltaInFlight(delta),
            }
            : {}),
        ...(setOnPromptAcceptedByProvider
            ? {
                setOnPromptAcceptedByProvider: (handler: PluginRuntimePromptAcceptedHandler | null) => {
                    setOnPromptAcceptedByProvider(handler
                        ? (info) => handler(publicAcceptedInfoToInternal(info))
                        : null);
                },
            }
            : {}),
        ...(setOnPromptTerminallyRejectedBeforeProvider
            ? {
                setOnPromptTerminallyRejectedBeforeProvider: (
                    handler: PluginRuntimePromptAcceptedHandler | null,
                ) => {
                    setOnPromptTerminallyRejectedBeforeProvider(handler
                        ? (info) => handler(publicAcceptedInfoToInternal(info))
                        : null);
                },
            }
            : {}),
        ...(setOnUndeliverablePrompts
            ? {
                setOnUndeliverablePrompts: (
                    handler: ((prompts: ReadonlyArray<PluginRuntimeUndeliverablePrompt>) => void) | null,
                ) => {
                    setOnUndeliverablePrompts(handler
                        ? (prompts) => handler(prompts.map((prompt) => {
                            const localInputId = normalizeNonEmptyString(prompt.localInputId);
                            const localIds = normalizeNonEmptyStringList([
                                ...(localInputId ? [localInputId] : []),
                                ...(prompt.localInputIds ?? []),
                            ]);
                            const userMessageSeqs = normalizeSeqList([
                                ...(typeof prompt.userMessageSeq === 'number' && Number.isFinite(prompt.userMessageSeq)
                                    ? [Math.trunc(prompt.userMessageSeq)]
                                    : []),
                                ...(prompt.userMessageSeqs ?? []),
                            ]);
                            return {
                                text: prompt.text,
                                userMessageSeq: typeof prompt.userMessageSeq === 'number' && Number.isFinite(prompt.userMessageSeq)
                                    ? Math.trunc(prompt.userMessageSeq)
                                    : null,
                                ...(localIds.length > 0 ? { localIds } : {}),
                                ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
                            };
                        }))
                        : null);
                },
            }
            : {}),
        ...(clearTerminalComposer
            ? {
                clearTerminalComposer: (request: Parameters<PluginRuntimeClearTerminalComposer>[0]) =>
                    clearTerminalComposer(request),
            }
            : {}),
        async waitForTurnCompletion(opts?: RuntimeTurnCompletionOptions) {
            await waitForSubmittedPrompt();
            if (waitForTurnCompletion) {
                const completion = currentCompletion;
                const waitOptions = publicRuntimeWaitOptionsWithDefault(opts);
                const customWait = Promise.resolve()
                    .then(() => waitForTurnCompletion(waitOptions))
                    .then(
                        () => {
                            completion?.settle();
                        },
                        (error: unknown) => {
                            const normalizedError = errorFromUnknown(error);
                            completion?.fail(normalizedError);
                            throw normalizedError;
                        },
                    );
                customWait.catch(() => undefined);
                const bridgeWait = completion?.wait(waitOptions);
                bridgeWait?.catch(() => undefined);
                if (bridgeWait) {
                    await Promise.race([customWait, bridgeWait]);
                } else {
                    await customWait;
                }
                return;
            }
            await currentCompletion?.wait(opts);
        },
        subscribeRuntimeEvents(handler: RuntimeTurnMessageHandler) {
            return runtime.events.subscribe(handler);
        },
        ...(permissions?.capability === 'responds'
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    return await permissions.respond({ requestId, approved });
                },
            }
            : {}),
        async cancelTurn() {
            if (cancelTurn) {
                await cancelTurn();
                return;
            }
            const result: RuntimeCancelResultV1 | undefined = await runtime.cancel?.({ reason: 'user' });
            if (result?.status === 'unavailable') {
                throw new Error(result.diagnostic ?? 'Plugin session runtime cancel is unavailable');
            }
        },
        readSessionIdentity(): RuntimeTurnSessionIdentity {
            return readSessionIdentity?.() ?? readPublicRuntimeIdentity(runtime);
        },
        async updateSessionRuntimeConfig(update: RuntimeTurnConfigUpdate) {
            if (updateSessionRuntimeConfig) {
                return await updateSessionRuntimeConfig(normalizePublicConfigUpdate(update));
            }
            return await runtime.updateConfig?.(normalizePublicConfigUpdate(update));
        },
        async resetOrDisposeRuntime() {
            runtimeEventUnsubscribe();
            if (resetOrDisposeRuntime) {
                await resetOrDisposeRuntime({ reason: 'session_closed' });
                return;
            }
            await runtime.dispose('session_closed');
        },
    });
}

function adaptPublicSessionRuntimeToTurnOperations(params: Readonly<{
    initialRuntime: SessionRuntimeV1;
    recreateRuntime?: (opts?: RuntimeTurnStartOrLoadOptions) => Promise<SessionRuntimeV1>;
}>): PluginRuntimeHookOperations {
    if (!params.recreateRuntime) {
        return adaptSinglePublicSessionRuntimeToTurnOperations(params.initialRuntime);
    }

    let currentOperations = adaptSinglePublicSessionRuntimeToTurnOperations(params.initialRuntime);
    let runtimeClosed = false;
    const runtimeEventHandlers = new Set<RuntimeTurnMessageHandler>();
    let runtimeEventUnsubscribe: (() => void) | null = null;
    let promptAcceptedHandler: PluginRuntimePromptAcceptedHandler | null = null;
    let promptTerminallyRejectedHandler: PluginRuntimePromptAcceptedHandler | null = null;
    let undeliverablePromptsHandler: ((prompts: ReadonlyArray<PluginRuntimeUndeliverablePrompt>) => void) | null = null;

    const detachRuntimeEvents = (): void => {
        runtimeEventUnsubscribe?.();
        runtimeEventUnsubscribe = null;
    };

    const attachRuntimeEvents = (): void => {
        detachRuntimeEvents();
        if (runtimeEventHandlers.size === 0) return;
        runtimeEventUnsubscribe = currentOperations.subscribeRuntimeEvents((event) => {
            for (const handler of Array.from(runtimeEventHandlers)) {
                handler(event);
            }
        });
    };

    const reapplyRuntimeHandlers = (): void => {
        if (promptAcceptedHandler && !currentOperations.setOnPromptAcceptedByProvider) {
            throw new Error('Recreated plugin session runtime dropped its provider-acceptance seam after the host registered a provider-acceptance handler');
        }
        currentOperations.setOnPromptAcceptedByProvider?.(promptAcceptedHandler);
        currentOperations.setOnPromptTerminallyRejectedBeforeProvider?.(promptTerminallyRejectedHandler);
        currentOperations.setOnUndeliverablePrompts?.(undeliverablePromptsHandler);
    };

    const recreateClosedRuntime = async (opts?: RuntimeTurnStartOrLoadOptions): Promise<void> => {
        if (!runtimeClosed) return;
        const nextRuntime = await params.recreateRuntime?.(opts);
        if (!nextRuntime) return;
        currentOperations = adaptSinglePublicSessionRuntimeToTurnOperations(nextRuntime);
        try {
            reapplyRuntimeHandlers();
            runtimeClosed = false;
            attachRuntimeEvents();
        } catch (error) {
            detachRuntimeEvents();
            runtimeClosed = true;
            await currentOperations.resetOrDisposeRuntime().catch(() => undefined);
            throw error;
        }
    };

    return Object.freeze({
        get permissionCapability() {
            return currentOperations.permissionCapability;
        },
        beginTurnLifecycle() {
            currentOperations.beginTurnLifecycle();
        },
        async startOrLoadSession(opts?: RuntimeTurnStartOrLoadOptions) {
            await recreateClosedRuntime(opts);
            return await currentOperations.startOrLoadSession(opts);
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
        async applyConfigDeltaInFlight(delta: Parameters<PluginRuntimeApplyConfigDeltaInFlight>[0]) {
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
                    currentOperations.setOnPromptAcceptedByProvider?.(handler);
                },
            }
            : {}),
        setOnPromptTerminallyRejectedBeforeProvider(handler: PluginRuntimePromptAcceptedHandler | null) {
            promptTerminallyRejectedHandler = handler;
            currentOperations.setOnPromptTerminallyRejectedBeforeProvider?.(handler);
        },
        setOnUndeliverablePrompts(handler: ((prompts: ReadonlyArray<PluginRuntimeUndeliverablePrompt>) => void) | null) {
            undeliverablePromptsHandler = handler;
            currentOperations.setOnUndeliverablePrompts?.(handler);
        },
        clearTerminalComposer(request: Parameters<PluginRuntimeClearTerminalComposer>[0]) {
            return currentOperations.clearTerminalComposer?.(request)
                ?? buildUnsupportedSessionTerminalComposerClearResult(
                    request.sessionId,
                    'session.terminalComposer.clear',
                );
        },
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
        async resetOrDisposeRuntime() {
            try {
                await currentOperations.resetOrDisposeRuntime();
            } finally {
                runtimeClosed = true;
                detachRuntimeEvents();
            }
        },
    });
}

function buildPublicSessionRuntimeParams(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    sessionInput: PluginSessionBindingInput;
    runtime: HostSessionRuntimeFactoryParams;
}>): CreateSessionRuntimeParamsV1 & Readonly<Record<string, unknown>> {
    return Object.freeze({
        sessionId: params.runtime.session.sessionId,
        backendId: params.backend.id,
        cwd: params.runtime.directory,
        directory: params.runtime.directory,
        permissionMode: params.sessionInput.runtimePreferences.permission?.mode ?? params.runtime.getPermissionMode(),
        metadata: params.runtime.metadata,
        credentials: params.sessionInput.credentials,
        accountSettings: params.runtime.accountSettings ?? null,
        mcpServers: clonePublicSessionMcpServers(params.runtime.mcpServers),
        ...(params.sessionInput.bootstrap.environmentVariables
            ? { env: { ...params.sessionInput.bootstrap.environmentVariables } }
            : {}),
        sessionModeId: params.sessionInput.runtimePreferences.sessionMode?.id,
        modelId: params.sessionInput.runtimePreferences.model?.id,
        ...(params.sessionInput.resume.resumeSessionId ? { resume: params.sessionInput.resume.resumeSessionId } : {}),
    });
}

function buildPluginDisplayName(provider: ResolvedAgentContribution, backend: ResolvedAgentRuntimeContribution): string {
    const providerTitle = normalizeNonEmptyString(provider.runtimeSpec?.title);
    if (providerTitle) return providerTitle;

    const richDisplayName = provider.richDefinition?.provenance === 'external'
        ? normalizeNonEmptyString(provider.richDefinition.definition.display?.name)
        : null;
    if (richDisplayName) return richDisplayName;

    return normalizeNonEmptyString(backend.id) ?? normalizeNonEmptyString(provider.id) ?? 'Plugin Runtime';
}

function resolvePluginPolicyAgentId(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
}>): AgentId {
    const policyAgentId = resolveContributionProviderAgentId({
        backend: params.backend,
        provider: params.provider,
    });
    if (policyAgentId) {
        return policyAgentId;
    }

    throw new Error(
        `Plugin backend '${params.backend.id}' requires providerAgentId to resolve to an exact built-in policy agent id before it can become a live session runtime`,
    );
}

export async function createPluginSessionRuntimePlan(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
    launch: PluginSessionLaunchHandler;
    sessionInput: PluginSessionBindingInput;
}>): Promise<HostSessionRuntimePlan> {
    const displayName = buildPluginDisplayName(params.provider, params.backend);
    const policyAgentId = resolvePluginPolicyAgentId({
        backend: params.backend,
        provider: params.provider,
    });
    const TerminalDisplay = createProviderTerminalDisplay({
        title: displayName,
        footerName: displayName,
        accentColor: 'cyan',
    });

    return createCatalogHostSessionRuntimePlan({
        providerId: params.backend.id,
        opts: buildPluginHostSessionRuntimeOptions(params.sessionInput),
        config: createCatalogHostSessionRuntimeConfig({
            providerId: params.backend.id,
            config: {
                displayName,
                flavor: params.backend.id,
                policyAgentId,
                terminalDisplay: TerminalDisplay,
                userMessageDeliveryWatermarkMode: 'providerAcceptance',
                providerAcceptancePendingMaterialization:
                    params.sessionInput.runtimePreferences.providerAcceptancePendingMaterialization,
                formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
                createNativeRuntime: async (runtimeParams) => {
                    const sessionLaunchParams = buildPluginSessionLaunchParams({
                        backend: params.backend,
                        provider: params.provider,
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

export async function createPublicPluginSessionRuntimePlan(params: Readonly<{
    backend: ResolvedAgentRuntimeContribution;
    provider: ResolvedAgentContribution;
    createSessionRuntime: PublicSessionRuntimeCreate;
    sessionInput: PluginSessionBindingInput;
}>): Promise<HostSessionRuntimePlan> {
    const displayName = buildPluginDisplayName(params.provider, params.backend);
    const policyAgentId = resolvePluginPolicyAgentId({
        backend: params.backend,
        provider: params.provider,
    });
    const TerminalDisplay = createProviderTerminalDisplay({
        title: displayName,
        footerName: displayName,
        accentColor: 'cyan',
    });

    return createCatalogHostSessionRuntimePlan({
        providerId: params.backend.id,
        opts: buildPluginHostSessionRuntimeOptions(params.sessionInput),
        config: createCatalogHostSessionRuntimeConfig({
            providerId: params.backend.id,
            config: {
                displayName,
                flavor: params.backend.id,
                policyAgentId,
                terminalDisplay: TerminalDisplay,
                formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
                createNativeRuntime: async (runtimeParams) => {
                    const publicRuntimeParams = buildPublicSessionRuntimeParams({
                        backend: params.backend,
                        sessionInput: params.sessionInput,
                        runtime: runtimeParams,
                    });
                    const { resume: _initialResume, ...runtimeParamsWithoutResume } =
                        publicRuntimeParams as CreateSessionRuntimeParamsV1 & Readonly<Record<string, unknown>>;
                    void _initialResume;
                    const publicRuntime = await params.createSessionRuntime(publicRuntimeParams);
                    return adaptPublicSessionRuntimeToTurnOperations({
                        initialRuntime: publicRuntime,
                        recreateRuntime: async (opts) => {
                            const resumeId = normalizeNonEmptyString(opts?.resumeId);
                            return await params.createSessionRuntime(Object.freeze({
                                ...runtimeParamsWithoutResume,
                                ...(resumeId ? { resume: resumeId } : {}),
                            }));
                        },
                    });
                },
            },
        }),
    });
}
