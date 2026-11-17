import type { ActionExecutionOptions, PluginActionInputById, PluginActionResultById } from '../actions/index.js';
import type { ActionFailureCauseV1 } from '../actions/dtos/pluginActionDtoSupport.generated.js';
import { isPluginError, readPluginErrorRequestIdV1 } from '../errors.js';
import type { OpenNewSessionOptions, OpenNewSessionRequest } from '../ui/index.js';
import type { SessionInputDeliveryOutcomeV1 } from './inputDelivery.js';

/** Public diagnostic identifiers only; no exception messages or private details. */
export type SessionInputLifecycleFailureV1 = Readonly<{ codes: string[]; requestId?: string }>;
export function projectSessionInputLifecycleFailureV1(error: unknown): SessionInputLifecycleFailureV1 | undefined {
    if (!isPluginError(error)) return undefined;
    const requestId = readPluginErrorRequestIdV1(error);
    return { codes: [error.code, ...(error.diagnostics ?? []).map(diagnostic => diagnostic.code)],
        ...(requestId === undefined ? {} : { requestId }) };
}

export type SessionInputAuthoringHostV1 = Readonly<{
    version(): Readonly<{ methods: readonly string[] }>;
    openNewSession?(request: OpenNewSessionRequest, options?: OpenNewSessionOptions): Promise<void>;
}>;
export type SessionInputAuthoringResultV1 = Readonly<{ status: 'seeded' }>
    | Readonly<{ status: 'unsupported' }> | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'unavailable'; failure?: SessionInputLifecycleFailureV1 }>;

/** The ordinary New Session composer owns the resulting draft and explicit Send. */
export async function openSessionInputAuthoringV1(input: Readonly<{
    host: SessionInputAuthoringHostV1;
    seed: OpenNewSessionRequest;
    options?: OpenNewSessionOptions;
    projectFailure?: typeof projectSessionInputLifecycleFailureV1;
}>): Promise<SessionInputAuthoringResultV1> {
    let methods: readonly string[];
    try { methods = input.host.version().methods; } catch { return { status: 'unsupported' }; }
    if (!methods.includes('openNewSession') || !input.host.openNewSession) return { status: 'unsupported' };
    try { await input.host.openNewSession(input.seed, input.options); }
    catch (error) {
        const declined = 'plugin_action_current_intent_rejected';
        if (isPluginError(error) && (error.code === declined
            || error.diagnostics?.some(diagnostic => diagnostic.code === declined))) return { status: 'cancelled' };
        const failure = (input.projectFailure ?? projectSessionInputLifecycleFailureV1)(error);
        return { status: 'unavailable', ...(failure === undefined ? {} : { failure }) };
    }
    return { status: 'seeded' };
}

export type SessionInputOpenInvokerV1 = (actionId: 'session.open', input: PluginActionInputById['session.open'],
    options?: ActionExecutionOptions) => Promise<unknown>;
export type SessionInputSpawnInvokerV1 = (actionId: 'session.spawn_new', input: PluginActionInputById['session.spawn_new'],
    options?: ActionExecutionOptions) => Promise<PluginActionResultById['session.spawn_new']>;

/** A documented pre-creation refusal is terminal; all other throws retain
 * the caller's same-key creation recovery rather than inventing a settlement. */
export async function spawnSessionInputDestinationV1(input: Readonly<{
    execute: SessionInputSpawnInvokerV1;
    spawn: PluginActionInputById['session.spawn_new'];
    signal?: AbortSignal;
}>): Promise<PluginActionResultById['session.spawn_new']> {
    try { return await input.execute('session.spawn_new', input.spawn, input.signal ? { signal: input.signal } : undefined); }
    catch (error) {
        if (isPluginError(error) && error.code === 'target_unavailable') return {
            type: 'error', code: 'target_unavailable', retryable: error.retryable,
        };
        throw error;
    }
}

/** Preserve the creator's cause; older launch replies supply only a native code. */
export function projectSessionInputSpawnFailureV1(result: Extract<PluginActionResultById['session.spawn_new'], { type: 'error' }>): Readonly<{ failureCause?: ActionFailureCauseV1 }> {
    const launchError = 'launchError' in result ? result.launchError : undefined;
    const failureCause = ('failureCause' in result ? result.failureCause : undefined) ?? (launchError === undefined ? undefined : {
        phase: 'session.spawn_new', errorClass: 'Error' as const,
        errorCode: null, nativeErrorCode: launchError.code, httpStatus: null,
    });
    return failureCause === undefined ? {} : { failureCause };
}

export async function openSessionInputDestinationV1(input: Readonly<{
    execute: SessionInputOpenInvokerV1;
    sessionId: string;
    serverId?: string;
    destination?: PluginActionInputById['session.open']['destination'];
    signal?: AbortSignal;
    projectFailure?: typeof projectSessionInputLifecycleFailureV1;
}>): Promise<Readonly<{ status: 'opened' }> | Readonly<{ status: 'failed'; failure?: SessionInputLifecycleFailureV1 }>> {
    try {
        await input.execute('session.open', { sessionId: input.sessionId,
            ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
            ...(input.destination === undefined ? {} : { destination: input.destination }),
        }, input.signal ? { signal: input.signal } : undefined);
        return { status: 'opened' };
    } catch (error) {
        const failure = (input.projectFailure ?? projectSessionInputLifecycleFailureV1)(error);
        return { status: 'failed', ...(failure === undefined ? {} : { failure }) };
    }
}

export type SessionInputLifecycleDeliveryV1 = SessionInputDeliveryOutcomeV1 | 'notRequested';
export type SessionInputLifecycleResultV1<TContext> = TContext & Readonly<{
    delivery: SessionInputLifecycleDeliveryV1;
    deliveryResult?: PluginActionResultById['session.message.send'];
}> & (Readonly<{ type: 'linked'; finalOpen: 'deferred' | 'suppressed' }>
    | Readonly<{ type: 'opened' | 'openPending'; failure?: SessionInputLifecycleFailureV1 }>);
/** Linking belongs to the source adapter; every linked start and retry completes
 * the same delivery-before-navigation sequence here. Context is returned unchanged. */
export async function completeSessionInputLifecycleV1<TContext extends Readonly<{ sessionId: string }>>(input: Readonly<{
    context: TContext;
    deliver?: () => Promise<Readonly<{ delivery: SessionInputLifecycleDeliveryV1;
        deliveryResult?: PluginActionResultById['session.message.send'] }>>;
    settledDelivery?: Exclude<SessionInputLifecycleDeliveryV1, 'outcomeUnknown'>;
    finalOpen?: 'deferred' | 'suppressed';
    open: () => ReturnType<typeof openSessionInputDestinationV1>;
}>): Promise<SessionInputLifecycleResultV1<TContext>> {
    const delivered = input.settledDelivery === undefined
        ? input.deliver === undefined ? { delivery: 'notRequested' as const } : await input.deliver()
        : { delivery: input.settledDelivery };
    if (input.finalOpen !== undefined) return { ...input.context, ...delivered, type: 'linked', finalOpen: input.finalOpen };
    const opened = await input.open();
    return { ...input.context, ...delivered, type: opened.status === 'opened' ? 'opened' : 'openPending',
        ...(opened.status === 'failed' && opened.failure !== undefined ? { failure: opened.failure } : {}) };
}
