import type { ActionSessionAddressV1 } from '../../actions/sessionAddressV1.js';
import type { ActionExecuteFailure, ActionApprovalRequestCreatedResult } from '../../actions/actionExecutionResult.js';
import type { SessionAuthoringOpenResultV1 } from '../../plugins/ui/hostApiRequests.js';
import type { SessionSpawnNewActionAuthoringInputV2 } from '../creation/sessionSpawnNewInputV2.js';
import type { SessionSpawnNewActionResultV1 } from '../creation/sessionSpawnNewResultV1.js';
import type { SessionMessageSendActionResultV1 } from './sessionInputAdmission.js';
import type { SessionInputHandoffInputV1, SessionInputHandoffContentV1, SessionInputHandoffResultV1, SessionInputHandoffNewDestinationV1 } from './sessionInputHandoffV1.js';

type SessionInputHandoffSpawnV1 = SessionSpawnNewActionAuthoringInputV2;

export type SessionInputHandoffEffectV1<T> = Readonly<{ ok: true; result: T | ActionApprovalRequestCreatedResult }> | ActionExecuteFailure;
export type SessionInputHandoffDepsV1 = Readonly<{
    send(input: Readonly<{ session: ActionSessionAddressV1; input: SessionInputHandoffContentV1; idempotencyKey: string }>, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<SessionMessageSendActionResultV1>>;
    spawn?(input: SessionInputHandoffSpawnV1, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<SessionSpawnNewActionResultV1>>;
    compose?(session: ActionSessionAddressV1, input: SessionInputHandoffContentV1, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<'composed' | 'composerUnavailable'>>;
    author?(seed: SessionInputHandoffNewDestinationV1['seed'], input: SessionInputHandoffContentV1, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<SessionAuthoringOpenResultV1>>;
}>;
export type SessionInputHandoffExecutionV1 = Readonly<{ resolvedSession?: ActionSessionAddressV1; signal?: AbortSignal }>;
export type SessionInputDestinationAddressV1 = Readonly<{ sessionId: string; serverId?: string }>;
export type SessionInputDestinationResultV1<TResult> = Readonly<{ kind: 'completed'; result: TResult }>
    | Readonly<{ kind: 'creationResult'; result: Exclude<SessionSpawnNewActionResultV1, { type: 'success' }> }>
    | Extract<SessionInputHandoffResultV1, { kind: 'failed' | 'approvalPending' | 'selectionRequired' }>;

/** Complete an admitted destination after its native creation settles. Source
 * adapters may commit their relationships before completing Session input. */
export function runSessionInputDestinationV1<TSession extends SessionInputDestinationAddressV1, TResult>(
    destination: Readonly<{ kind: 'existing'; session: TSession }> | Readonly<{ kind: 'new'; spawn: SessionInputHandoffSpawnV1 }>,
    deps: Readonly<{
        spawn(input: SessionInputHandoffSpawnV1, signal?: AbortSignal): Promise<Readonly<{ ok: true; result: SessionSpawnNewActionResultV1 }>>;
        complete(session: TSession | ActionSessionAddressV1, creation?: Extract<SessionSpawnNewActionResultV1, { type: 'success' }>): Promise<TResult>;
    }>, signal?: AbortSignal): Promise<Extract<SessionInputDestinationResultV1<TResult>, { kind: 'completed' | 'creationResult' }>>;
export function runSessionInputDestinationV1<TSession extends SessionInputDestinationAddressV1, TResult>(
    destination: Readonly<{ kind: 'existing'; session: TSession }> | Readonly<{ kind: 'new'; spawn: SessionInputHandoffSpawnV1 }>,
    deps: Readonly<{
        spawn?: SessionInputHandoffDepsV1['spawn'];
        complete(session: TSession | ActionSessionAddressV1, creation?: Extract<SessionSpawnNewActionResultV1, { type: 'success' }>): Promise<TResult>;
    }>, signal?: AbortSignal): Promise<SessionInputDestinationResultV1<TResult>>;
export async function runSessionInputDestinationV1<TSession extends SessionInputDestinationAddressV1, TResult>(
    destination: Readonly<{ kind: 'existing'; session: TSession }> | Readonly<{ kind: 'new'; spawn: SessionInputHandoffSpawnV1 }>,
    deps: Readonly<{
        spawn?: SessionInputHandoffDepsV1['spawn'];
        complete(session: TSession | ActionSessionAddressV1, creation?: Extract<SessionSpawnNewActionResultV1, { type: 'success' }>): Promise<TResult>;
    }>, signal?: AbortSignal): Promise<SessionInputDestinationResultV1<TResult>> {
    if (destination.kind === 'existing') return { kind: 'completed', result: await deps.complete(destination.session) };
    if (deps.spawn === undefined) return { kind: 'selectionRequired', fields: ['placement'] };
    const effect = settle(await deps.spawn(destination.spawn, signal), 'create');
    if (effect.kind !== 'settled') return effect;
    if (effect.result.type !== 'success') return { kind: 'creationResult', result: effect.result };
    const session = { serverId: effect.result.executionTarget.serverId, sessionId: effect.result.sessionId };
    return { kind: 'completed', result: await deps.complete(session, effect.result) };
}

export function resolveSessionInputHandoffDeliveryV1(requested: SessionInputHandoffInputV1['delivery'], configured: 'compose' | 'send'): 'compose' | 'send';
export function resolveSessionInputHandoffDeliveryV1(requested: SessionInputHandoffInputV1['delivery'], configured?: 'compose' | 'send'): 'compose' | 'send' | undefined;
export function resolveSessionInputHandoffDeliveryV1(requested: SessionInputHandoffInputV1['delivery'], configured?: 'compose' | 'send') {
    return requested === 'configured' ? configured : requested;
}

/** Resolve only saved behavior. Source adapters retain configuration and launch defaults. */
export function resolveSessionInputHandoffSelectionV1(input: Pick<SessionInputHandoffInputV1, 'sessionChoice' | 'delivery' | 'defaults' | 'newSession'>) {
    const destination = input.sessionChoice.kind === 'configured' ? input.defaults?.destination
        : input.sessionChoice.kind === 'existing' ? input.sessionChoice : input.newSession
            ?? (input.defaults?.destination.kind === 'new' ? input.defaults.destination : undefined);
    const delivery = resolveSessionInputHandoffDeliveryV1(input.delivery, input.defaults?.delivery);
    return { destination, delivery, authoring: input.sessionChoice.kind === 'new' || delivery === 'compose'
        || destination?.kind === 'new' && destination.spawn === undefined };
}

/** Internal legacy callers may retain an ambient Home; the public handoff has an exact address. */
export async function sendSessionInputHandoffV1<TSession extends Readonly<{ sessionId: string; serverId?: string }>>(
    input: Readonly<{ session: TSession; input: SessionInputHandoffContentV1; idempotencyKey: string }>,
    deps: Readonly<{ send(value: typeof input, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<SessionMessageSendActionResultV1>> }>,
    signal?: AbortSignal): Promise<Readonly<{ kind: 'sendResult'; session: TSession; result: SessionMessageSendActionResultV1 }>
        | Extract<SessionInputHandoffResultV1, { kind: 'failed' | 'approvalPending' }>> {
    const effect = settle(await deps.send(input, signal), 'send');
    return effect.kind === 'settled' ? { kind: 'sendResult', session: input.session, result: effect.result } : effect;
}

export async function composeSessionInputHandoffV1(session: ActionSessionAddressV1, input: SessionInputHandoffContentV1,
    compose: NonNullable<SessionInputHandoffDepsV1['compose']>, signal?: AbortSignal): Promise<Extract<SessionInputHandoffResultV1, { kind: 'composed' | 'unavailable' | 'failed' | 'approvalPending' }>> {
    const effect = settle(await compose(session, input, signal), 'compose');
    if (effect.kind !== 'settled') return effect;
    return effect.result === 'composed' ? { kind: 'composed', destination: { kind: 'existing', session } }
        : { kind: 'unavailable', reason: 'composerUnavailable' };
}

function isApproval<T>(result: T | ActionApprovalRequestCreatedResult): result is ActionApprovalRequestCreatedResult {
    return typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'approval_request_created';
}
function settle<T>(effect: SessionInputHandoffEffectV1<T>, phase: 'compose' | 'create' | 'send'):
    Readonly<{ kind: 'settled'; result: T }> | Extract<SessionInputHandoffResultV1, { kind: 'failed' | 'approvalPending' }> {
    if (!effect.ok) return { kind: 'failed', phase, failure: effect };
    const result = effect.result;
    return isApproval(result) ? { kind: 'approvalPending', phase, result } : { kind: 'settled', result };
}

/** One generic destination/effect owner for native hosts and source adapters.
 * Native child Action receipts remain intact; the supplied keys own recovery. */
export async function runSessionInputHandoffV1(input: SessionInputHandoffInputV1, deps: SessionInputHandoffDepsV1,
    execution: SessionInputHandoffExecutionV1 = {}): Promise<SessionInputHandoffResultV1> {
    if (execution.signal?.aborted) return { kind: 'cancelled' };
    const selected = resolveSessionInputHandoffSelectionV1(input);
    if (selected.destination === undefined) return { kind: 'unavailable', reason: 'configuredDestinationUnavailable' };
    if (selected.delivery === undefined) return { kind: 'selectionRequired', fields: ['delivery'] };
    if (selected.destination.kind === 'new' && selected.authoring) {
        if (deps.author === undefined) return { kind: 'unavailable', reason: 'composerUnavailable' };
        const effect = settle(await deps.author(selected.destination.seed, input.input, execution.signal), 'compose');
        if (effect.kind !== 'settled') return effect;
        return { kind: 'authoringResult', result: effect.result };
    }
    let destination: Readonly<{ kind: 'existing'; session: ActionSessionAddressV1 }>
        | Readonly<{ kind: 'new'; spawn: SessionInputHandoffSpawnV1 }>;
    if (selected.destination.kind === 'existing') {
        if (execution.resolvedSession === undefined) return { kind: 'selectionRequired', fields: ['sessionChoice'] };
        destination = { kind: 'existing', session: execution.resolvedSession };
    } else {
        if (selected.destination.spawn === undefined) return { kind: 'selectionRequired', fields: ['placement'] };
        destination = { kind: 'new', spawn: selected.destination.spawn };
    }
    const completed = await runSessionInputDestinationV1(destination, {
        spawn: deps.spawn,
        complete: async (session): Promise<SessionInputHandoffResultV1> => {
            if (selected.delivery === 'compose') {
                if (deps.compose === undefined) return { kind: 'unavailable', reason: 'composerUnavailable' };
                return composeSessionInputHandoffV1(session, input.input, deps.compose, execution.signal);
            }
            return sendSessionInputHandoffV1({ session, input: input.input, idempotencyKey: input.idempotencyKey }, deps, execution.signal);
        },
    }, execution.signal);
    return completed.kind === 'completed' ? completed.result : completed;
}
