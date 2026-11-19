import {
    SessionInputHandoffInputV1Schema as canonicalInputSchema, SessionInputHandoffResultV1Schema as canonicalResultSchema,
    SessionInputHandoffSessionChoiceV1ProtocolSchema,
    SessionInputHandoffDeliveryChoiceV1ProtocolSchema,
    SessionInputHandoffSendResultV1ProtocolSchema,
    SessionInputHandoffCompositionResultV1ProtocolSchema,
} from '@happier-dev/protocol/sessions/messages/sessionInputHandoffV1';
import type { PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import type { PluginActionInputById } from '../actions/actionTypeMap.generated.js';
import type { ActionApprovalRequestCreatedResult, ActionExecuteResult } from '../actions/dtos/pluginActionDtoSupport.generated.js';
import type { ProtocolComposableSchema, ProtocolSchemaInput, ProtocolSchemaOutput } from '../protocol/protocolFacade.js';
import type { SessionSchema } from '../services/sessions.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';
import type { ActionSessionAddressV1, SessionTargetV1 } from './sessionTargets.js';
import type { SessionInputForgeEvidenceV1 } from './forgeEvidence.js';
import { runSessionInputHandoffV1 as canonicalRun, runSessionInputDestinationV1 as canonicalDestination, sendSessionInputHandoffV1 as canonicalSend, composeSessionInputHandoffV1 as canonicalCompose,
    resolveSessionInputHandoffDeliveryV1 as canonicalDelivery, resolveSessionInputHandoffSelectionV1 as canonicalResolve } from '@happier-dev/protocol/sessions/messages/runSessionInputHandoffV1';

/** Structural author declarations; Protocol retains the parser. */
export type SessionInputHandoffSessionChoiceV1 = Readonly<{ kind: 'configured' }>
    | Readonly<{ kind: 'existing'; session: SessionTargetV1 }> | Readonly<{ kind: 'new' }>;
export type SessionInputHandoffSendResultV1 = Readonly<{
    kind: 'sendResult'; session: ActionSessionAddressV1; result: PluginActionResultById['session.message.send'];
}>;
export type SessionInputHandoffCompositionResultV1 = Readonly<{
    kind: 'composed'; destination: Readonly<{ kind: 'existing'; session: ActionSessionAddressV1 }>
        | Readonly<{ kind: 'newSessionDraft' }>;
}>;
export const SessionInputHandoffSessionChoiceV1Schema: ProtocolComposableSchema<SessionInputHandoffSessionChoiceV1> = SessionInputHandoffSessionChoiceV1ProtocolSchema;
export const SessionInputHandoffDeliveryChoiceV1Schema: ProtocolComposableSchema<'configured' | 'compose' | 'send'> = SessionInputHandoffDeliveryChoiceV1ProtocolSchema;
export const SessionInputHandoffSendResultV1Schema: ProtocolComposableSchema<
    ProtocolSchemaInput<typeof SessionInputHandoffSendResultV1ProtocolSchema>,
    ProtocolSchemaOutput<typeof SessionInputHandoffSendResultV1ProtocolSchema>
> = SessionInputHandoffSendResultV1ProtocolSchema;
export const SessionInputHandoffCompositionResultV1Schema: ProtocolComposableSchema<SessionInputHandoffCompositionResultV1> = SessionInputHandoffCompositionResultV1ProtocolSchema;

export type SessionInputHandoffNewDestinationV1 = Readonly<{
    kind: 'new'; seed: Extract<PluginActionInputById['session.authoring.open'], { seed: unknown }>['seed'];
    spawn?: PluginActionInputById['session.spawn_new'] & { initialInput?: never };
}>;
export type SessionInputHandoffContentV1 = Readonly<{
    text: string; attachments?: NonNullable<Extract<PluginActionInputById['session.message.send'], { message: string }>['attachments']>;
    forgeEvidence?: SessionInputForgeEvidenceV1;
}>;
export type SessionInputHandoffInputV1 = Readonly<{
    v: 1; sessionChoice: SessionInputHandoffSessionChoiceV1; delivery: 'configured' | 'compose' | 'send';
    defaults?: Readonly<{ destination: Readonly<{ kind: 'existing'; session: SessionTargetV1 }>
        | SessionInputHandoffNewDestinationV1; delivery: 'compose' | 'send' }>;
    newSession?: SessionInputHandoffNewDestinationV1; input: SessionInputHandoffContentV1; idempotencyKey: string;
}>;
type HandoffFailure = Extract<ActionExecuteResult, { ok: false }>;
export type SessionInputHandoffResultV1 = SessionInputHandoffSendResultV1 | SessionInputHandoffCompositionResultV1
    | Readonly<{ kind: 'authoringResult'; result: PluginActionResultById['session.authoring.open'] }>
    | Readonly<{ kind: 'creationResult'; result: PluginActionResultById['session.spawn_new'] }>
    | Readonly<{ kind: 'selectionRequired'; fields: ('sessionChoice' | 'delivery' | 'placement')[] }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'failed'; phase: 'compose' | 'create' | 'send'; failure: HandoffFailure }>
    | Readonly<{ kind: 'approvalPending'; phase: 'compose' | 'create' | 'send'; result: ActionApprovalRequestCreatedResult }>
    | Readonly<{ kind: 'unavailable'; reason: 'composerUnavailable' | 'configuredDestinationUnavailable' }>;
export type SessionInputHandoffEffectV1<T> = Readonly<{ ok: true; result: T | ActionApprovalRequestCreatedResult }> | HandoffFailure;
export type SessionInputHandoffDepsV1 = Readonly<{
    send(input: Readonly<{ session: ActionSessionAddressV1; input: SessionInputHandoffContentV1; idempotencyKey: string }>, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<PluginActionResultById['session.message.send']>>;
    spawn?(input: PluginActionInputById['session.spawn_new'], signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<PluginActionResultById['session.spawn_new']>>;
    compose?(session: ActionSessionAddressV1, input: SessionInputHandoffContentV1, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<'composed' | 'composerUnavailable'>>;
    author?(seed: SessionInputHandoffNewDestinationV1['seed'], input: SessionInputHandoffContentV1, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<PluginActionResultById['session.authoring.open']>>;
}>;
export type SessionInputHandoffExecutionV1 = Readonly<{ resolvedSession?: ActionSessionAddressV1; signal?: AbortSignal }>;
export const SessionInputHandoffInputV1Schema: SessionSchema<SessionInputHandoffInputV1> = /* @__PURE__ */ projectProtocolValue(canonicalInputSchema);
export const SessionInputHandoffResultV1Schema: SessionSchema<SessionInputHandoffResultV1> = /* @__PURE__ */ projectProtocolValue(canonicalResultSchema);
export const runSessionInputHandoffV1: (input: SessionInputHandoffInputV1, deps: SessionInputHandoffDepsV1,
    execution?: SessionInputHandoffExecutionV1) => Promise<SessionInputHandoffResultV1> = /* @__PURE__ */ projectProtocolValue(canonicalRun);
export type SessionInputDestinationResultV1<TResult> = Readonly<{ kind: 'completed'; result: TResult }>
    | Readonly<{ kind: 'creationResult'; result: Exclude<PluginActionResultById['session.spawn_new'], { type: 'success' }> }>
    | Extract<SessionInputHandoffResultV1, { kind: 'failed' | 'approvalPending' | 'selectionRequired' }>;
export const runSessionInputDestinationV1: {
    <TSession extends Readonly<{ sessionId: string; serverId?: string }>, TResult>(
        destination: Readonly<{ kind: 'existing'; session: TSession }>
            | Readonly<{ kind: 'new'; spawn: PluginActionInputById['session.spawn_new'] }>,
        deps: Readonly<{ spawn(input: PluginActionInputById['session.spawn_new'], signal?: AbortSignal): Promise<Readonly<{ ok: true; result: PluginActionResultById['session.spawn_new'] }>>;
            complete(session: TSession | ActionSessionAddressV1, creation?: Extract<PluginActionResultById['session.spawn_new'], { type: 'success' }>): Promise<TResult> }>,
        signal?: AbortSignal,
    ): Promise<Extract<SessionInputDestinationResultV1<TResult>, { kind: 'completed' | 'creationResult' }>>;
    <TSession extends Readonly<{ sessionId: string; serverId?: string }>, TResult>(
        destination: Readonly<{ kind: 'existing'; session: TSession }>
            | Readonly<{ kind: 'new'; spawn: PluginActionInputById['session.spawn_new'] }>,
        deps: Readonly<{ spawn?: SessionInputHandoffDepsV1['spawn'];
            complete(session: TSession | ActionSessionAddressV1, creation?: Extract<PluginActionResultById['session.spawn_new'], { type: 'success' }>): Promise<TResult> }>,
        signal?: AbortSignal,
    ): Promise<SessionInputDestinationResultV1<TResult>>;
} = /* @__PURE__ */ projectProtocolValue(canonicalDestination);
export const sendSessionInputHandoffV1: <TSession extends Readonly<{ sessionId: string; serverId?: string }>>(
    input: Readonly<{ session: TSession; input: SessionInputHandoffContentV1; idempotencyKey: string }>,
    deps: Readonly<{ send(value: typeof input, signal?: AbortSignal): Promise<SessionInputHandoffEffectV1<PluginActionResultById['session.message.send']>> }>,
    signal?: AbortSignal,
) => Promise<Readonly<{ kind: 'sendResult'; session: TSession; result: PluginActionResultById['session.message.send'] }>
    | Extract<SessionInputHandoffResultV1, { kind: 'failed' | 'approvalPending' }>> = /* @__PURE__ */ projectProtocolValue(canonicalSend);
export const composeSessionInputHandoffV1: (session: ActionSessionAddressV1, input: SessionInputHandoffContentV1,
    compose: NonNullable<SessionInputHandoffDepsV1['compose']>, signal?: AbortSignal) => Promise<Extract<SessionInputHandoffResultV1, { kind: 'composed' | 'unavailable' | 'failed' | 'approvalPending' }>> = /* @__PURE__ */ projectProtocolValue(canonicalCompose);
export const resolveSessionInputHandoffDeliveryV1: {
    (requested: SessionInputHandoffInputV1['delivery'], configured: 'compose' | 'send'): 'compose' | 'send';
    (requested: SessionInputHandoffInputV1['delivery'], configured?: 'compose' | 'send'): 'compose' | 'send' | undefined;
} = canonicalDelivery;
export const resolveSessionInputHandoffSelectionV1: (input: Pick<SessionInputHandoffInputV1, 'sessionChoice' | 'delivery' | 'defaults' | 'newSession'>) => Readonly<{
    destination: Readonly<{ kind: 'existing'; session: SessionTargetV1 }> | SessionInputHandoffNewDestinationV1 | undefined;
    delivery: 'compose' | 'send' | undefined; authoring: boolean;
}> = /* @__PURE__ */ projectProtocolValue(canonicalResolve);
