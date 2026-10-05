import { randomUUID } from 'node:crypto';

import { PluginError, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type {
    ApprovalQueueService,
    CurrentSessionPresentationIntentV1,
    InteractionOptions,
    InteractionTransientApprovalAuthorRequestV1,
    InteractionTransientApprovalResultV1,
    InteractionTransientConfirmationAuthorRequestV1,
    InteractionTransientConfirmationResultV1,
    InteractionTransientQuestionsAuthorRequestV1,
    InteractionTransientQuestionsResultV1,
    InteractionSeverity,
    InteractionsService,
    PresentationService,
    UiWidget,
} from '@happier-dev/plugin-sdk/interactions';
import type {
    HostCurrentSessionUiServices as CurrentSessionUiServices,
    HostSessionPresentationOneShotResult,
    HostSessionPresentationOwner,
    HostSessionPresentationStatefulResult,
    HostSessionInteractionOptions,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';
import { CurrentSessionPresentationAuthorIntentV1Schema, type InteractionTransientRequesterV1 } from '@happier-dev/protocol';
import type { AgentInvocationTurnAdmissionWitness, PluginInvocationServicesSeed } from './types';
import { isWorkflowInteractionCapacityError } from '@/agent/permissions/interactionPersistenceError';

type PresentationResult = HostSessionPresentationOneShotResult | HostSessionPresentationStatefulResult;
type AppliedPresentationResult = Readonly<{ status: 'applied' | 'unchanged'; revision: string }>;
type CurrentSessionUiBinding = Readonly<{
    interactions?: CurrentSessionUiServices['interactions'];
    presentation?: CurrentSessionUiServices['presentation'];
}>;

function throwUiError(
    code: string,
    message: string,
    diagnostic?: PluginDiagnosticData,
): never {
    throw new PluginError({
        code,
        message: diagnostic?.message ?? message,
        ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
    });
}

function assertPresentationApplied(result: PresentationResult): asserts result is AppliedPresentationResult {
    if (result.status === 'applied' || result.status === 'unchanged') return;
    if (result.status === 'outcomeUnknown') {
        throwUiError(
            'plugin_ui_outcome_unknown',
            'The host may have applied the UI request without returning a conclusive acknowledgement',
            result.diagnostic,
        );
    }
    if (result.status === 'conflict') {
        throwUiError('plugin_ui_conflict', 'The host rejected the UI request because its target changed', result.diagnostic);
    }
    throwUiError(
        'plugin_ui_unavailable',
        'The requested UI operation is unavailable',
        'diagnostic' in result ? result.diagnostic : undefined,
    );
}

function createUnavailableInteractions(
    approvals?: ApprovalQueueService,
    createRequestId: () => string = randomUUID,
): InteractionsService {
    const fail = async (): Promise<never> => throwUiError(
        'plugin_interaction_unavailable',
        'Plugin interaction requires a bound current session with available host interaction services',
    );
    return Object.freeze({
        requestApproval: async () => Object.freeze({
            requestId: createRequestId(),
            kind: 'approval' as const,
            status: 'unavailable' as const,
        }),
        askQuestions: async () => Object.freeze({
            requestId: createRequestId(),
            kind: 'questions' as const,
            status: 'unavailable' as const,
        }),
        confirm: async () => Object.freeze({
            requestId: createRequestId(),
            kind: 'confirmation' as const,
            status: 'unavailable' as const,
        }),
        approvals: approvals ?? Object.freeze({ request: fail, get: fail, list: fail, watch: fail }),
    });
}

function createUnavailablePresentation(): PresentationService {
    const fail = async (): Promise<never> => throwUiError(
        'plugin_ui_unavailable',
        'Plugin presentation requires a bound current session with available host presentation services',
    );
    return Object.freeze({
        present: fail,
        notify: fail,
        status: Object.freeze({ set: fail }),
        widget: Object.freeze({ set: fail }),
        composer: Object.freeze({ replace: fail }),
    });
}

function approvalUnavailable(requestId: string): InteractionTransientApprovalResultV1 {
    return Object.freeze({
        requestId,
        kind: 'approval',
        status: 'unavailable',
    });
}

function questionsUnavailable(requestId: string): InteractionTransientQuestionsResultV1 {
    return Object.freeze({
        requestId,
        kind: 'questions',
        status: 'unavailable',
    });
}

function confirmationUnavailable(requestId: string): InteractionTransientConfirmationResultV1 {
    return Object.freeze({ requestId, kind: 'confirmation', status: 'unavailable' });
}

type InvocationInteractionParams = Readonly<{
    currentSession: CurrentSessionUiBinding | null;
    signal: AbortSignal;
    isOccurrenceCurrent: () => boolean;
    createOperationId?: () => string;
    approvals?: ApprovalQueueService;
    permissionOwner?: PermissionRequestOwner;
    requester?: InteractionTransientRequesterV1;
    /**
     * Exact target-action provenance stamped by the invocation host. It is
     * absent outside a host context that can prove immutable occurrenceId and
     * contribution identity, so status/widget writes fail closed there.
     */
    presentationOwner?: HostSessionPresentationOwner;
    /** Host-owned current-turn reader; plugins never supply this carrier. */
    readActiveTurnAdmissionWitness?(): AgentInvocationTurnAdmissionWitness | null;
}>;

export function createInteractionTransientRequesterForInvocation(
    seed: Pick<PluginInvocationServicesSeed, 'plugin' | 'contribution' | 'occurrenceId' | 'correlationId'>,
): InteractionTransientRequesterV1 {
    if (!seed.occurrenceId) {
        throw new Error('Transient plugin interactions require a current process-local occurrence');
    }
    return Object.freeze({
        pluginId: seed.plugin.id,
        contributionId: seed.contribution.id,
        occurrenceId: seed.occurrenceId,
        invocationId: seed.correlationId,
    });
}

type InvocationPresentationParams = Omit<InvocationInteractionParams, 'isOccurrenceCurrent'> & Readonly<{
    isOccurrenceCurrent: () => boolean;
}>;

function readActiveTurnPermissionContext(
    params: InvocationInteractionParams,
) {
    if (!params.readActiveTurnAdmissionWitness) return undefined;
    try {
        const witness = params.readActiveTurnAdmissionWitness();
        return Object.freeze({
            turnId: witness?.turnId ?? null,
            causalPermissionAuthority: witness?.causalPermissionAuthority ?? null,
        });
    } catch {
        // A broken host reader is an active-turn authority failure, never legacy.
        return Object.freeze({ turnId: null, causalPermissionAuthority: null });
    }
}

export function createPluginInteractionsService(params: InvocationInteractionParams): InteractionsService {
    const createOperationId = params.createOperationId ?? randomUUID;
    if (!params.currentSession) return createUnavailableInteractions(params.approvals, createOperationId);

    const currentSession = params.currentSession;
    const isCurrent = (): boolean => {
        let current = false;
        try {
            current = !params.signal.aborted && params.isOccurrenceCurrent();
        } catch {
            current = false;
        }
        return current;
    };
    const assertCurrent = (): void => {
        const current = isCurrent();
        if (!current) {
            throwUiError(
                'plugin_interaction_occurrence_retired',
                'The plugin occurrence is no longer current',
            );
        }
    };
    const operationOptions = (options?: InteractionOptions): HostSessionInteractionOptions => {
        const signal = options?.signal;
        const activeTurnPermissionContext = readActiveTurnPermissionContext(params);
        const permissionContext = params.permissionOwner || activeTurnPermissionContext !== undefined || options?.lifetime !== undefined
            ? Object.freeze({
                ...(params.permissionOwner ? { owner: params.permissionOwner } : {}),
                ...(options?.lifetime ? { lifetime: options.lifetime } : {}),
                ...(activeTurnPermissionContext !== undefined
                    ? {
                        turnId: activeTurnPermissionContext.turnId,
                        causalPermissionAuthority: activeTurnPermissionContext.causalPermissionAuthority,
                    }
                    : {}),
            })
            : undefined;
        return Object.freeze({
            signal: signal && signal !== params.signal
                ? AbortSignal.any([params.signal, signal])
                : params.signal,
            ...(permissionContext ? { permissionContext } : {}),
            ...(params.requester ? { requester: params.requester } : {}),
        });
    };

    return Object.freeze({
        async requestApproval(
            request: InteractionTransientApprovalAuthorRequestV1,
            interactionOptions?: InteractionOptions,
        ): Promise<InteractionTransientApprovalResultV1> {
            const fallbackRequestId = createOperationId();
            if (!currentSession.interactions) {
                return approvalUnavailable(fallbackRequestId);
            }
            try {
                assertCurrent();
                const result = await currentSession.interactions.request(request, operationOptions(interactionOptions));
                return result;
            } catch (error) {
                if (isWorkflowInteractionCapacityError(error)) throw error;
                if (params.signal.aborted || interactionOptions?.signal?.aborted) {
                    return Object.freeze({ requestId: fallbackRequestId, kind: 'approval', status: 'requesterAborted' });
                }
                if (!isCurrent()) {
                    return Object.freeze({ requestId: fallbackRequestId, kind: 'approval', status: 'occurrenceRetired' });
                }
                return approvalUnavailable(fallbackRequestId);
            }
        },
        async askQuestions(
            request: InteractionTransientQuestionsAuthorRequestV1,
            questionOptions?: InteractionOptions,
        ): Promise<InteractionTransientQuestionsResultV1> {
            const fallbackRequestId = createOperationId();
            if (!currentSession.interactions) {
                return questionsUnavailable(fallbackRequestId);
            }
            try {
                assertCurrent();
                const result = await currentSession.interactions.request(request, operationOptions(questionOptions));
                return result;
            } catch (error) {
                if (isWorkflowInteractionCapacityError(error)) throw error;
                if (params.signal.aborted || questionOptions?.signal?.aborted) {
                    return Object.freeze({ requestId: fallbackRequestId, kind: 'questions', status: 'requesterAborted' });
                }
                if (!isCurrent()) {
                    return Object.freeze({ requestId: fallbackRequestId, kind: 'questions', status: 'occurrenceRetired' });
                }
                return questionsUnavailable(fallbackRequestId);
            }
        },
        async confirm(
            request: InteractionTransientConfirmationAuthorRequestV1,
            confirmOptions?: InteractionOptions,
        ): Promise<InteractionTransientConfirmationResultV1> {
            const fallbackRequestId = createOperationId();
            if (!currentSession.interactions) return confirmationUnavailable(fallbackRequestId);
            try {
                assertCurrent();
                const result = await currentSession.interactions.request(request, operationOptions(confirmOptions));
                return result;
            } catch (error) {
                if (isWorkflowInteractionCapacityError(error)) throw error;
                if (params.signal.aborted || confirmOptions?.signal?.aborted) {
                    return Object.freeze({ requestId: fallbackRequestId, kind: 'confirmation', status: 'requesterAborted' });
                }
                if (!isCurrent()) {
                    return Object.freeze({ requestId: fallbackRequestId, kind: 'confirmation', status: 'occurrenceRetired' });
                }
                return confirmationUnavailable(fallbackRequestId);
            }
        },
        approvals: params.approvals ?? createUnavailableInteractions(undefined, createOperationId).approvals,
    });
}

export function createPluginInvocationPresentation(params: InvocationPresentationParams): PresentationService {
    if (!params.currentSession) return createUnavailablePresentation();

    const createOperationId = params.createOperationId ?? randomUUID;
    const currentSession = params.currentSession;
    const presentationOwner = params.presentationOwner;
    const isCurrent = (): boolean => {
        let current = false;
        try {
            current = !params.signal.aborted && params.isOccurrenceCurrent();
        } catch {
            current = false;
        }
        return current;
    };
    const assertCurrent = (): void => {
        const current = isCurrent();
        if (!current) {
            throwUiError('plugin_ui_generation_retired', 'The plugin occurrenceId is no longer current');
        }
    };
    const operationOptions = (signal?: AbortSignal): Readonly<{ signal: AbortSignal }> => Object.freeze({
        signal: signal && signal !== params.signal
            ? AbortSignal.any([params.signal, signal])
            : params.signal,
    });

    const retireOwnedPresentation = () => {
        if (!currentSession.presentation || !presentationOwner) return;
        void currentSession.presentation.purgeOwner({
            operationId: createOperationId(),
            owner: presentationOwner,
        }).catch(() => {
            // Retirement cleanup is best effort only after the invocation has
            // lost authority; it must not create an unhandled rejection.
        });
    };
    if (currentSession.presentation && presentationOwner) {
        params.signal.addEventListener('abort', retireOwnedPresentation, { once: true });
        if (params.signal.aborted) retireOwnedPresentation();
    }

    return Object.freeze({
        async present(intent: CurrentSessionPresentationIntentV1, mutationOptions?: Readonly<{ signal?: AbortSignal }>) {
            assertCurrent();
            const admitted = CurrentSessionPresentationAuthorIntentV1Schema.safeParse(intent);
            if (!admitted.success) {
                throwUiError('plugin_ui_invalid_presentation_intent', 'Use widget Actions for widget instance mutations');
            }
            if (!currentSession.presentation) {
                throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
            }
            const result = await currentSession.presentation.present({
                operationId: createOperationId(),
                intent: admitted.data,
            }, operationOptions(mutationOptions?.signal));
            assertCurrent();
            assertPresentationApplied(result);
        },
        async notify(message: string, notifyOptions?: Readonly<{ severity?: InteractionSeverity; signal?: AbortSignal }>) {
            assertCurrent();
            if (!currentSession.presentation) {
                throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
            }
            const result = await currentSession.presentation.notify({
                operationId: createOperationId(),
                message,
                severity: notifyOptions?.severity ?? 'info',
            }, operationOptions(notifyOptions?.signal));
            assertCurrent();
            assertPresentationApplied(result);
        },
        status: Object.freeze({
            async set(key: string, text: string | null, mutationOptions?: Readonly<{ signal?: AbortSignal }>) {
                assertCurrent();
                if (!currentSession.presentation || !presentationOwner) {
                    throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
                }
                const result = await currentSession.presentation.setStatus({
                    operationId: createOperationId(),
                    key,
                    text,
                    owner: presentationOwner,
                }, operationOptions(mutationOptions?.signal));
                assertCurrent();
                assertPresentationApplied(result);
            },
        }),
        widget: Object.freeze({
            async set(key: string, widget: UiWidget | null, mutationOptions?: Readonly<{ signal?: AbortSignal }>) {
                assertCurrent();
                if (!currentSession.presentation || !presentationOwner) {
                    throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
                }
                const result = await currentSession.presentation.setWidget({
                    operationId: createOperationId(),
                    key,
                    placement: widget?.placement ?? 'beforeComposer',
                    lines: widget?.lines ?? null,
                    owner: presentationOwner,
                }, operationOptions(mutationOptions?.signal));
                assertCurrent();
                assertPresentationApplied(result);
            },
        }),
        composer: Object.freeze({
            async replace(text: string, mutationOptions?: Readonly<{ signal?: AbortSignal }>) {
                assertCurrent();
                if (!currentSession.presentation) {
                    throwUiError('plugin_ui_unavailable', 'The requested UI presentation operation is unavailable');
                }
                const result = await currentSession.presentation.replaceComposerText({
                    operationId: createOperationId(),
                    text,
                }, operationOptions(mutationOptions?.signal));
                assertCurrent();
                assertPresentationApplied(result);
            },
        }),
    });
}
