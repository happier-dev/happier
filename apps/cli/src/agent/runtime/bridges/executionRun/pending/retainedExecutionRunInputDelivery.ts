import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readSessionAttachmentDescriptorsV1 } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';
import { readHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { readSessionInputCausalPermissionAuthorityV1, readSessionInputAuthority } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { resolveSessionInputPromptProvenanceV1, renderSessionInputContextBlockV1, renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { SessionRunPromptContextV1 } from '@happier-dev/protocol';
import { readAdmittedHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime/input/structuredInputV1';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunAdmittedPendingInputV1 } from '@/api/session/client/transport/sessionClientInteractionApi';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import {
    isSessionProviderInputOutcomeTerminal,
    type SessionProviderInputOutcome,
} from '@/agent/runtime/session/input/providerInputOutcome';
import { readAdmittedSessionMediaInputForDispatchV1 } from '@/session/services/admitSessionStructuredInputV1';
import { resolveStructuredInputProviderDispatchContext } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { projectExecutionRunWorkflowInputAcceptance } from '../executionRunWorkflowObservation';
import { appendExecutionRunControllerHostBarrier } from '@/agent/executionRuns/controllers/failureSignal';
import { createExecutionRunDiagnosticError, projectExecutionRunError } from '../errors';

import type {
    ExecutionRunPendingInputDelivery,
    ExecutionRunRuntimeDeliveryOutcome,
} from './executionRunPendingInputConsumer';

/** The same text projection is used for actual delivery and its prepared reservation. */
export function renderRetainedExecutionRunInputPrompt(
    params: Parameters<typeof renderSessionInputContextPromptV1>[0] & Readonly<{ profileContext?: string }>,
): string {
    const { profileContext, ...context } = params;
    return [profileContext, renderSessionInputContextPromptV1(context)].filter(Boolean).join('\n\n');
}

export function readRetainedExecutionRunInputTextReservation(
    params: Omit<Parameters<typeof renderRetainedExecutionRunInputPrompt>[0], 'transformedUserText'>,
): number {
    // A real scalar keeps the renderer's context-to-user separator present.
    // Remove only that scalar, leaving the exact rendered envelope reservation.
    let scalars = 0;
    for (const _character of renderRetainedExecutionRunInputPrompt({ ...params, transformedUserText: 'a' })) scalars += 1;
    return scalars - 1;
}

export type RetainedExecutionRunInputDelivery = Readonly<{
    delivery: ExecutionRunPendingInputDelivery;
    /**
     * This Run's own admitted-turn witness while its turn is in flight.
     *
     * It is `null` between turns, so a tool call can never borrow authority from
     * a turn that already settled or from the parent Session's concurrent turn.
     */
    readActiveTurnAdmissionWitness: () => AgentInvocationTurnAdmissionWitness | null;
    dispose: () => void;
}>;

export type RetainedExecutionRunInputDeliveryOptions = Readonly<{
    runId: string;
    agentId?: string;
    controller: ExecutionRunBackendController;
    onInputTurnUpdated?: () => void;
    onTurnComplete?: (turn: Readonly<{ turnId: string; inputIds?: readonly string[]; rawText: string; finishedAtMs: number }>) => Promise<void>;
    onTurnFailed?: (turn: Readonly<{ turnId: string; inputIds?: readonly string[]; rawText: string; finishedAtMs: number;
        diagnostic: Readonly<{ code: string; message?: string }> }>) => Promise<void>;
    sessionRunContext?: SessionRunPromptContextV1;
    readInitialProfileContext?: () => string;
    /**
     * The incumbent connected-service generation check. It runs immediately before
     * every provider effect; canonical Session admission does not authorize the
     * use of stale credentials.
     */
    authorizeProviderEffect: () => Promise<Readonly<{ ok: boolean; errorCode?: string; error?: string }>>;
    /** Capture the profile's publication basis before this exact input can have a provider effect. */
    beforeProviderInput?: (localId: string) => Promise<void>;
    /** Install exact input custody only once this delivery can actually affect the native runtime. */
    beforeNativeInputDispatch?: (localId: string) => void;
    structuredInputContext?: Omit<
        Parameters<typeof resolveStructuredInputProviderDispatchContext>[0],
        'structuredInput' | 'sessionMedia' | 'composerAttachments'
    > & Readonly<{
        composerAttachments?: Omit<
            NonNullable<Parameters<typeof resolveStructuredInputProviderDispatchContext>[0]['composerAttachments']>,
            'localId'
        >;
    }>;
}>;

/**
 * Deliver one admitted input into the exact retained Agent Session runtime.
 *
 * The provider action is chosen from the canonical pending vocabulary the server
 * already resolved for this target, combined with this Run's own turn activity —
 * never the parent Session's. A refusal is reported only when it happened before
 * any provider effect; anything else stays outcome-unknown so the durable row
 * remains `delivering` for the incumbent reconciliation owner.
 */
export function createRetainedExecutionRunInputDelivery(
    options: RetainedExecutionRunInputDeliveryOptions,
): RetainedExecutionRunInputDelivery {
    const { controller, runId } = options;
    let activeTurnId: string | null = null;
    const beginTurn = (turnId: string) => {
        if (activeTurnId === turnId) return;
        controller.initialInputPending = false;
        activeTurnId = turnId;
        controller.turnEpoch += 1;
        controller.turnCount += 1;
        controller.turnInFlight = true;
        controller.buffer = '';
        controller.turnResultContract = undefined;
        controller.sidechainStreamBuffer = '';
        controller.sidechainStreamKey = '';
    };
    const unsubscribeRuntimeEvents = controller.backend.subscribeRuntimeEvents?.((event) => {
        if (controller.cancelled || controller.delegatedTurn) return;
        if (event.kind === 'input-accepted') {
            if (controller.pendingHostInput && event.inputIds.includes(controller.pendingHostInput)) {
                controller.pendingHostInput = undefined;
            }
            projectExecutionRunWorkflowInputAcceptance(controller, runId, event);
            const previous = controller.currentInputTurn;
            const inputIds = previous?.turnId === event.delivery.turnId
                ? [...new Set([...previous.inputIds, ...event.inputIds])]
                : [...event.inputIds];
            controller.currentInputTurn = {
                turnId: event.delivery.turnId,
                inputIds: [inputIds[0]!, ...inputIds.slice(1)],
                state: 'active',
            };
            beginTurn(event.delivery.turnId);
            options.onInputTurnUpdated?.();
        } else if (event.kind === 'turn-start') {
            beginTurn(event.turnId);
            options.onInputTurnUpdated?.();
        } else if (event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled') {
            // Earlier model deltas can still be queued behind input acceptance on this barrier.
            if (event.kind === 'turn-complete' && activeTurnId === event.turnId && options.onTurnComplete) {
                const completed = { turnId: event.turnId, finishedAtMs: event.emittedAtMs,
                    inputIds: controller.currentInputTurn?.turnId === event.turnId ? controller.currentInputTurn.inputIds : undefined };
                controller.pendingHostBarrier = appendExecutionRunControllerHostBarrier(
                    controller, () => options.onTurnComplete!({ ...completed, rawText: controller.buffer }), options.onInputTurnUpdated,
                );
            }
            if (event.kind === 'turn-failed' && activeTurnId === event.turnId && options.onTurnFailed) {
                const failed = { turnId: event.turnId, finishedAtMs: event.emittedAtMs,
                    inputIds: controller.currentInputTurn?.turnId === event.turnId ? controller.currentInputTurn.inputIds : undefined,
                    diagnostic: event.diagnostic };
                controller.pendingHostBarrier = appendExecutionRunControllerHostBarrier(
                    controller, () => options.onTurnFailed!({ ...failed, rawText: controller.buffer }), options.onInputTurnUpdated,
                );
            }
            if (controller.currentInputTurn?.turnId === event.turnId) {
                controller.lastInputTurn = {
                    ...controller.currentInputTurn,
                    state: event.kind === 'turn-complete' ? 'completed' : event.kind === 'turn-failed' ? 'failed' : 'cancelled',
                    ...(event.kind === 'turn-failed' ? { error: projectExecutionRunError(
                        createExecutionRunDiagnosticError(event.diagnostic, event.emittedAtMs, options.agentId), { runId },
                    ) } : {}),
                };
                controller.currentInputTurn = undefined;
            }
            if (activeTurnId === event.turnId) {
                activeTurnId = null;
                controller.turnInFlight = false;
            }
            if (controller.turnCancelReason === 'cancel') {
                controller.turnCancelReason = null;
                controller.turnCancelEpoch = null;
            }
            options.onInputTurnUpdated?.();
        }
    });
    // This delivery instance belongs to one provider occurrence. Explicit
    // pre-effect refusal retains its initial context; unknown custody does not
    // authorize replay, and a new occurrence gets a new delivery instance.
    let contextInitialized = false;
    let contextInputLocalId: string | null = null;

    const readProviderEffectRefusal = async (): Promise<ExecutionRunRuntimeDeliveryOutcome | null> => {
        const authorized = controller.delegatedTurn
            ? { ok: false, errorCode: 'execution_run_busy', error: 'Run is busy' }
            : await options.authorizeProviderEffect();
        const delegated = Boolean(controller.delegatedTurn);
        return authorized.ok && !delegated ? null : {
            status: 'rejected_before_effect',
            reason: 'provider_unavailable_before_acceptance',
            diagnostic: {
                code: delegated ? 'execution_run_busy' : authorized.errorCode ?? 'execution_run_provider_effect_unauthorized',
                message: authorized.error ?? `Execution run '${runId}' may not produce a provider effect.`,
                severity: 'error',
            },
            retryable: true,
        };
    };

    const deliver = async (
        input: ExecutionRunAdmittedPendingInputV1,
    ): Promise<ExecutionRunRuntimeDeliveryOutcome> => {
        const localId = typeof input.localId === 'string' ? input.localId.trim() : '';
        const runtimeId = controller.runtimeId;
        if (!runtimeId) {
            return {
                status: 'rejected_before_effect',
                reason: 'provider_unavailable_before_acceptance',
                diagnostic: {
                    code: 'execution_run_not_provisioned',
                    message: `Execution run '${runId}' has no provisioned runtime.`,
                    severity: 'error',
                },
                retryable: true,
            };
        }

        const providerAction = input.pendingProviderAction;
        const wantsSteer = providerAction === 'steer';
        const steer = controller.backend.steerInput;
        if (wantsSteer && typeof steer !== 'function') {
            // Declared steer support is the authority; a missing method is never
            // silently downgraded to cancel-and-send.
            return {
                status: 'rejected_before_effect',
                reason: 'steering_unavailable',
                diagnostic: {
                    code: 'execution_run_steer_unsupported',
                    message: `Execution run '${runId}' does not support steering.`,
                    severity: 'error',
                },
                retryable: false,
            };
        }

        const admittedStructuredInput = readAdmittedHappierStructuredInputV1FromMeta(input.meta);
        const structuredInput = admittedStructuredInput.status === 'admitted'
            ? admittedStructuredInput.structuredInput
            : readHappierStructuredInputV1FromMeta(input.meta);
        const media = structuredInput
            ? readAdmittedSessionMediaInputForDispatchV1({ meta: input.meta, structuredInput })
            : { status: 'absent' as const };
        if (admittedStructuredInput.status === 'invalid' || media.status === 'invalid') {
            return {
                status: 'rejected_before_effect',
                reason: 'provider_rejected_before_acceptance',
                diagnostic: { code: 'session_structured_input_invalid', severity: 'error' },
                retryable: false,
            };
        }
        let resolved: Awaited<ReturnType<typeof resolveStructuredInputProviderDispatchContext>>;
        try {
            const {
                composerAttachments,
                ...structuredInputContext
            } = options.structuredInputContext ?? {};
            resolved = await resolveStructuredInputProviderDispatchContext({
                ...structuredInputContext,
                ...(composerAttachments
                    ? {
                        composerAttachments: {
                            ...composerAttachments,
                            localId,
                        },
                    }
                    : {}),
                structuredInput,
                attachments: readSessionAttachmentDescriptorsV1(input.meta),
                ...(media.status === 'admitted' ? { sessionMedia: media.media } : {}),
            });
        } catch {
            return {
                status: 'rejected_before_effect',
                reason: 'provider_unavailable_before_acceptance',
                diagnostic: { code: 'session_structured_input_resolution_unavailable', severity: 'error' },
                retryable: true,
            };
        }
        const refusalBeforePreparation = await readProviderEffectRefusal();
        if (refusalBeforePreparation) return refusalBeforePreparation;

        try {
            if (options.beforeProviderInput) await options.beforeProviderInput(localId);
        } catch {
            return {
                status: 'rejected_before_effect',
                reason: 'provider_unavailable_before_acceptance',
                diagnostic: { code: 'execution_run_input_preparation_unavailable', severity: 'error' },
                retryable: true,
            };
        }

        // Preparation can await disk. Reuse the incumbent authority after that
        // boundary and never send through a cancelled or replaced occurrence.
        if (options.beforeProviderInput) {
            const refusalAfterPreparation = await readProviderEffectRefusal();
            if (refusalAfterPreparation) return refusalAfterPreparation;
        }
        if (controller.cancelled || controller.runtimeId !== runtimeId) {
            return {
                status: 'rejected_before_effect',
                reason: 'provider_unavailable_before_acceptance',
                diagnostic: { code: 'execution_run_not_provisioned', severity: 'error' },
                retryable: true,
            };
        }

        const causalPermissionAuthority = readSessionInputCausalPermissionAuthorityV1(input.meta, 'stored');
        const provenance = resolveSessionInputPromptProvenanceV1(input.meta);
        const authority = readSessionInputAuthority(input.meta, 'stored');
        const returnedAnswer = authority?.v === 1 ? authority.returnedAnswer : undefined;
        const sessionRunContext = !contextInitialized ? options.sessionRunContext : undefined;
        const profileContext = !contextInitialized ? options.readInitialProfileContext?.() : undefined;
        const runtimeInput = {
            text: renderRetainedExecutionRunInputPrompt({
                inputProvenance: provenance,
                returnedAnswer,
                provenanceBlock: renderSessionInputContextBlockV1({ provenance, returnedAnswer }),
                ...resolved.promptContext,
                ...(sessionRunContext ? { sessionRunContext } : {}),
                ...(profileContext ? { profileContext } : {}),
                transformedUserText: input.content.text,
            }),
            ...(resolved.structuredInput
                ? { structuredInput: normalizeStrictJsonValue(resolved.structuredInput) }
                : {}),
        };
        try {
            options.beforeNativeInputDispatch?.(localId);
            const meta = {
                localId,
                ...(causalPermissionAuthority ? { causalPermissionAuthority } : {}),
                ...(input.actionRequestAttributionV1 ? { actionRequestAttributionV1: input.actionRequestAttributionV1 } : {}),
            };
            if (sessionRunContext || profileContext) {
                contextInitialized = true;
                contextInputLocalId = localId;
            }
            let outcome: ExecutionRunRuntimeDeliveryOutcome;
            if (wantsSteer && steer) {
                outcome = await steer(runtimeId, runtimeInput, meta);
            } else {
                if (providerAction === 'interrupt_and_send') await controller.backend.cancel(runtimeId);
                outcome = await controller.backend.deliverInput(runtimeId, runtimeInput, meta);
            }
            if (contextInputLocalId === localId && (
                outcome.status === 'rejected' || outcome.status === 'unavailable' || outcome.status === 'unsupported'
            )) {
                contextInitialized = false;
                contextInputLocalId = null;
            }
            return outcome;
        } catch (error) {
            // The provider may already have consumed the input, so this is never a
            // refusal. The row stays `delivering` until the canonical owner classifies it.
            return {
                status: 'outcome_unknown',
                issue: error instanceof Error ? error.message : String(error),
            };
        }
    };

    return Object.freeze({
        delivery: Object.freeze({
            deliver,
            subscribeProviderInputOutcomes: (handler: (outcome: SessionProviderInputOutcome) => void) => controller.backend.subscribeProviderInputOutcomes?.((outcome) => {
                if (
                    outcome.localId === contextInputLocalId
                    && isSessionProviderInputOutcomeTerminal(outcome)
                ) {
                    if (outcome.kind === 'rejected_before_effect') contextInitialized = false;
                    contextInputLocalId = null;
                }
                handler(outcome);
            }) ?? (() => {}),
        }),
        readActiveTurnAdmissionWitness: () => controller.backend.readActiveTurnAdmissionWitness?.() ?? null,
        dispose: () => unsubscribeRuntimeEvents?.(),
    });
}
