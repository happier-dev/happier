import { isPluginError, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type {
    ApprovalQueueListItem,
    ApprovalQueueQuery,
    ApprovalQueueRequest,
    ApprovalQueueRequestResult,
    ApprovalQueueService,
    ApprovalQueueSnapshot,
    ApprovalRequest,
    ApprovalRequestStatus,
    InteractionOptions } from '@happier-dev/plugin-sdk/interactions';
import type {
    PluginInvocableActionId,
} from '@happier-dev/plugin-sdk/actions';
import type { Disposable } from '@happier-dev/plugin-sdk';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionPluginCaller } from '@happier-dev/protocol/actions';
import { normalizeStrictJsonValue } from '@happier-dev/protocol';

import {
    getSharedBlockingApprovalCoordinator,
    type BlockingApprovalCoordinator,
} from '../../../../session/actions/approvals/blockingApprovalCoordinator';

import type { PluginInvocationServicesSeed } from './types';
import { resolvePluginActionCaller } from './actionCaller';

export type ApprovalActionExecutor = Readonly<{
    execute(
        actionId: import('@happier-dev/protocol').ActionId,
        input: unknown,
        context?: import('@happier-dev/protocol/actions').ActionExecutorContext,
    ): Promise<import('@happier-dev/protocol/actions').ActionExecuteResult>;
}>;

type ApprovalQueueOwnerOptions = Readonly<{
    resolveExecutor: () => Promise<ApprovalActionExecutor | null>;
    coordinator?: BlockingApprovalCoordinator;
    recordDiagnostic?: (seed: PluginInvocationServicesSeed, error: unknown) => void;
}>;

export type StablePluginApprovalQueueOwner = Readonly<{
    bind(seed: PluginInvocationServicesSeed): ApprovalQueueService;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function throwApprovalQueueError(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function assertInvocationCurrent(seed: PluginInvocationServicesSeed, signal: AbortSignal): void {
    if (signal.aborted) {
        throwApprovalQueueError('plugin_interaction_cancelled', 'The approval queue operation was cancelled');
    }
    let current = false;
    try {
        current = seed.isGenerationCurrent();
    } catch {
        current = false;
    }
    if (!current) {
        throwApprovalQueueError(
            'plugin_interaction_generation_retired',
            'The plugin generation is no longer current',
        );
    }
}

function requirePluginActionCaller(seed: PluginInvocationServicesSeed): ActionPluginCaller {
    const caller = resolvePluginActionCaller(seed);
    if (!caller) {
        throwApprovalQueueError(
            'plugin_action_caller_unavailable',
            'Plugin approval requests require current host-stamped caller provenance',
        );
    }
    return caller;
}

function operationSignal(seed: PluginInvocationServicesSeed, supplied?: AbortSignal): AbortSignal {
    return supplied && supplied !== seed.signal
        ? AbortSignal.any([seed.signal, supplied])
        : seed.signal;
}

function readActionFailure(result: unknown): Readonly<Record<string, unknown>> | null {
    const record = readRecord(result);
    return record?.ok === false ? record : null;
}

function throwActionFailure(result: unknown): never {
    const failure = readActionFailure(result);
    const code = typeof failure?.errorCode === 'string'
        ? failure.errorCode
        : 'plugin_approval_queue_failed';
    const message = typeof failure?.error === 'string'
        ? failure.error
        : 'The approval queue operation failed';
    throwApprovalQueueError(code, message);
}

function readActionResult(result: unknown): Readonly<Record<string, unknown>> | null {
    return readRecord(readRecord(result)?.result);
}

/**
 * Admits one canonical strict JSON projection or reports the queue response as
 * invalid. The Protocol owner enforces dense arrays, plain objects, finite
 * numbers, and immutable snapshots — the local recursive predicate this
 * replaced accepted sparse arrays (holes are skipped by `every`) and
 * nonordinary objects (any prototype carrying finite own values).
 */
function strictJsonOrInvalidQueueResponse(value: unknown): JsonValue {
    try {
        return normalizeStrictJsonValue(value);
    } catch {
        return invalidQueueResponse();
    }
}

/** Omits the execution projection when the stored result is not strict JSON. */
function strictJsonExecutionResultOrOmit(value: unknown): JsonValue | undefined {
    if (value === undefined) return undefined;
    try {
        return normalizeStrictJsonValue(value);
    } catch {
        return undefined;
    }
}

function isApprovalStatus(value: unknown): value is ApprovalRequestStatus {
    return value === 'open'
        || value === 'approved'
        || value === 'rejected'
        || value === 'executed'
        || value === 'failed'
        || value === 'canceled';
}

function invalidQueueResponse(): never {
    throwApprovalQueueError(
        'plugin_approval_queue_invalid_response',
        'The approval queue returned an invalid response',
    );
}

function projectApprovalRequest(
    approvalRequestId: string,
    value: unknown,
): ApprovalRequest {
    const request = readRecord(value);
    if (
        !request
        || !isApprovalStatus(request.status)
        || typeof request.actionId !== 'string'
        || typeof request.summary !== 'string'
        || typeof request.createdAtMs !== 'number'
        || typeof request.updatedAtMs !== 'number'
    ) return invalidQueueResponse();
    const actionArgs = strictJsonOrInvalidQueueResponse(request.actionArgs);
    const decision = readRecord(request.decision);
    const execution = readRecord(request.execution);
    const executionResult = execution
        ? strictJsonExecutionResultOrOmit(execution.result)
        : null;
    return Object.freeze({
        approvalRequestId,
        status: request.status,
        actionId: request.actionId,
        input: actionArgs,
        summary: request.summary,
        createdAtMs: request.createdAtMs,
        updatedAtMs: request.updatedAtMs,
        ...(decision?.kind === 'approve' || decision?.kind === 'reject'
            ? typeof decision.decidedAtMs === 'number'
                ? { decision: Object.freeze({ kind: decision.kind, decidedAtMs: decision.decidedAtMs }) }
                : invalidQueueResponse()
            : {}),
        ...(execution
            ? typeof execution.executedAtMs === 'number' && typeof execution.ok === 'boolean'
                ? {
                    execution: Object.freeze({
                        executedAtMs: execution.executedAtMs,
                        ok: execution.ok,
                        ...(executionResult !== undefined ? { result: executionResult } : {}),
                        ...(typeof execution.errorCode === 'string' ? { errorCode: execution.errorCode } : {}),
                        ...(typeof execution.error === 'string' ? { error: execution.error } : {}),
                    }),
                }
                : invalidQueueResponse()
            : {}),
    });
}

function projectApprovalListItem(value: unknown): ApprovalQueueListItem {
    const item = readRecord(value);
    if (
        !item
        || typeof item.artifactId !== 'string'
        || !isApprovalStatus(item.status)
        || typeof item.actionId !== 'string'
        || typeof item.summary !== 'string'
        || typeof item.updatedAtMs !== 'number'
    ) return invalidQueueResponse();
    return Object.freeze({
        approvalRequestId: item.artifactId,
        status: item.status,
        actionId: item.actionId,
        summary: item.summary,
        updatedAtMs: item.updatedAtMs,
        ...(typeof item.sessionId === 'string' ? { sessionId: item.sessionId } : {}),
        ...(typeof item.serverId === 'string' ? { serverId: item.serverId } : {}),
    });
}

export function createStablePluginApprovalQueueOwner(
    options: ApprovalQueueOwnerOptions,
): StablePluginApprovalQueueOwner {
    const resolveExecutor = options.resolveExecutor;
    const coordinator = options.coordinator ?? getSharedBlockingApprovalCoordinator();

    return Object.freeze({
        bind(seed): ApprovalQueueService {
            const execute = async (
                actionId: 'approval.request.create' | 'approval.request.get' | 'approval.request.list',
                input: unknown,
                signal: AbortSignal,
                buildInput?: (caller: ActionPluginCaller) => unknown | Promise<unknown>,
            ): Promise<unknown> => {
                assertInvocationCurrent(seed, signal);
                const executor = await resolveExecutor();
                // The resolver can suspend while a plugin retires. Re-admit
                // immediately before binding or executing the host Action.
                assertInvocationCurrent(seed, signal);
                if (!executor) {
                    throwApprovalQueueError(
                        'plugin_interaction_unavailable',
                        'The approval queue is unavailable because the host is not authenticated',
                    );
                }
                // Resolve once for this Action edge. If input binding is needed,
                // it and the executor consume the exact same stamped caller.
                const actionCaller = requirePluginActionCaller(seed);
                const boundInput = buildInput ? await buildInput(actionCaller) : input;
                assertInvocationCurrent(seed, signal);
                const result = await executor.execute(actionId, boundInput, {
                    signal,
                    surface: 'plugin',
                    authority: 'account_automation',
                    actionCaller,
                    placement: null,
                    defaultSessionId: seed.session?.id ?? null,
                });
                assertInvocationCurrent(seed, signal);
                if (readActionFailure(result)) throwActionFailure(result);
                return result;
            };

            const service: ApprovalQueueService = Object.freeze({
                async request<TActionId extends PluginInvocableActionId>(
                    request: ApprovalQueueRequest<TActionId>,
                    requestOptions?: InteractionOptions,
                ): Promise<ApprovalQueueRequestResult> {
                    const signal = operationSignal(seed, requestOptions?.signal);
                    assertInvocationCurrent(seed, signal);
                    const spec = getActionSpec(request.actionId);
                    if (spec.surfaces.plugin !== true) {
                        throwApprovalQueueError(
                            'action_disabled',
                            `Action '${request.actionId}' is unavailable to plugin callers`,
                        );
                    }
                    const pluginInputSchema = spec.surfaceBindings?.plugin?.inputSchema ?? spec.inputSchema;
                    const parsedPluginInput = pluginInputSchema.safeParse(request.input);
                    if (!parsedPluginInput.success) {
                        throwApprovalQueueError(
                            'plugin_action_input_schema_invalid',
                            'Plugin approval input does not match its caller schema',
                        );
                    }
                    const result = readActionResult(await execute('approval.request.create', {
                        // The actual input is assembled after the current caller
                        // has been resolved, below.
                    }, signal, async (caller) => {
                        let semanticInput: unknown = parsedPluginInput.data;
                        if (spec.surfaceBindings?.plugin?.bindInput) {
                            try {
                                semanticInput = await spec.surfaceBindings.plugin.bindInput(
                                    parsedPluginInput.data,
                                    {
                                        actionId: request.actionId,
                                        surface: 'plugin',
                                        caller,
                                        ...(seed.session ? { defaultSessionId: seed.session.id } : {}),
                                        signal,
                                    },
                                );
                            } catch {
                                throwApprovalQueueError(
                                    'plugin_action_input_binding_failed',
                                    'Plugin approval input could not be bound to host authority',
                                );
                            }
                        }
                        return {
                            actionId: request.actionId,
                            actionArgs: semanticInput,
                            summary: request.summary ?? `Approve ${request.actionId}`,
                            createdBy: { surface: 'system' },
                        };
                    }));
                    const artifactId = typeof result?.artifactId === 'string'
                        ? result.artifactId
                        : null;
                    if (!artifactId) throwActionFailure(result);
                    return Object.freeze({ approvalRequestId: artifactId });
                },
                async get(
                    approvalRequestId: string,
                    requestOptions?: InteractionOptions,
                ): Promise<ApprovalRequest | null> {
                    const signal = operationSignal(seed, requestOptions?.signal);
                    let result: Readonly<Record<string, unknown>> | null;
                    try {
                        result = readActionResult(await execute('approval.request.get', {
                            artifactId: approvalRequestId,
                        }, signal));
                    } catch (error) {
                        if (isPluginError(error) && error.code === 'approval_not_found') return null;
                        throw error;
                    }
                    return projectApprovalRequest(approvalRequestId, result?.request);
                },
                async list(
                    query: ApprovalQueueQuery = {},
                    requestOptions?: InteractionOptions,
                ): Promise<ApprovalQueueSnapshot> {
                    const signal = operationSignal(seed, requestOptions?.signal);
                    const result = readActionResult(await execute('approval.request.list', query, signal));
                    const rawItems = Array.isArray(result?.items) ? result.items : [];
                    return Object.freeze({
                        items: Object.freeze(rawItems.map(projectApprovalListItem)),
                    });
                },
                async watch(
                    query: ApprovalQueueQuery | undefined,
                    listener: (snapshot: ApprovalQueueSnapshot) => void | Promise<void>,
                    requestOptions?: InteractionOptions,
                ): Promise<Disposable> {
                    const signal = operationSignal(seed, requestOptions?.signal);
                    assertInvocationCurrent(seed, signal);
                    let disposed = false;
                    let releaseInitial!: () => void;
                    let tail: Promise<void> = new Promise<void>((resolve) => {
                        releaseInitial = resolve;
                    });
                    const deliver = (): void => {
                        tail = tail.then(async () => {
                            if (disposed) return;
                            const snapshot: ApprovalQueueSnapshot = await service.list(query, { signal });
                            if (!disposed) await listener(snapshot);
                        }).catch((error) => {
                            if (!disposed && !signal.aborted) options.recordDiagnostic?.(seed, error);
                        });
                    };
                    const subscription = coordinator.subscribeApprovalChanges(({ request }) => {
                        if (!('kind' in request)) deliver();
                    });
                    const abort = (): void => dispose();
                    const dispose = (): void => {
                        if (disposed) return;
                        disposed = true;
                        signal.removeEventListener('abort', abort);
                        subscription.dispose();
                    };
                    signal.addEventListener('abort', abort, { once: true });
                    try {
                        const initial = await service.list(query, { signal });
                        if (!disposed) await listener(initial);
                        releaseInitial();
                    } catch (error) {
                        releaseInitial();
                        dispose();
                        throw error;
                    }
                    return Object.freeze({ dispose });
                },
            });
            return service;
        },
    });
}
