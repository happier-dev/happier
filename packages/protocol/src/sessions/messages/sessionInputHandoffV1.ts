import { z } from '../../zodRuntimePolicy.js';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { ActionSessionAddressV1Schema, type ActionSessionAddressV1 } from '../../actions/sessionAddressV1.js';
import { ActionSessionAddressV1ProtocolSchema, SessionTargetV1Schema, type SessionTargetV1 } from '../../actions/sessionTargetV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { defineProtocolLiteral, defineProtocolObject } from '../../plugins/actions/protocolComposableSchema.js';
import { PluginUiNewSessionSeedV1Schema, SessionAuthoringOpenResultV1Schema,
    type SessionAuthoringOpenResultV1 } from '../../plugins/ui/hostApiRequests.js';
import { SessionSpawnNewActionInputV2Schema } from '../creation/sessionSpawnNewInputV2.js';
import { SessionSpawnNewActionResultV1Schema, type SessionSpawnNewActionResultV1 } from '../creation/sessionSpawnNewResultV1.js';
import { PluginSessionInputAttachmentsV1Schema, requireSessionInputContent, type PluginSessionInputAttachmentAuthoringV1 } from './sessionInputAuthoringV1.js';
import { SessionInputForgeEvidenceV1Schema, type SessionInputForgeEvidenceV1 } from './sessionInputForgeEvidenceV1.js';
import { PluginSessionInputIdempotencyKeyV1Schema } from './sessionInputAdmission.js';
import { ActionExecuteFailureSchema, ActionApprovalRequestCreatedResultSchema,
    type ActionExecuteFailure, type ActionApprovalRequestCreatedResult } from '../../actions/actionExecutionResult.js';
import { SessionMessageSendResultV1ProtocolSchema,
    type SessionMessageSendActionResultV1 } from './sessionInputAdmission.js';

export type SessionInputHandoffSessionChoiceV1 = Readonly<{ kind: 'configured' }>
    | Readonly<{ kind: 'existing'; session: SessionTargetV1 }> | Readonly<{ kind: 'new' }>;
export type SessionInputHandoffSendResultV1 = Readonly<{
    kind: 'sendResult'; session: ActionSessionAddressV1; result: SessionMessageSendActionResultV1;
}>;
export type SessionInputHandoffCompositionResultV1 = Readonly<{
    kind: 'composed'; destination: Readonly<{ kind: 'existing'; session: ActionSessionAddressV1 }>
        | Readonly<{ kind: 'newSessionDraft' }>;
}>;
/** Generic handoff operands; configured preferences and evidence remain source-owned. */
export const SessionInputHandoffSessionChoiceV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ kind: z.literal('configured') }),
    z.strictObject({ kind: z.literal('existing'), session: SessionTargetV1Schema }),
    z.strictObject({ kind: z.literal('new') }),
]));
export const SessionInputHandoffDeliveryChoiceV1Schema = lazyZodSchema(() => z.enum(['configured', 'compose', 'send']));
export const SessionInputHandoffSendResultV1ProtocolSchema = lazyDefinition(() => defineProtocolObject({
    kind: defineProtocolLiteral('sendResult'), session: ActionSessionAddressV1ProtocolSchema,
    result: SessionMessageSendResultV1ProtocolSchema,
}, { policy: 'closed' }));
export const SessionInputHandoffSendResultV1Schema = lazyZodSchema(() =>
    asProtocolZod(SessionInputHandoffSendResultV1ProtocolSchema));
export const SessionInputHandoffCompositionResultV1Schema: z.ZodMiniType<SessionInputHandoffCompositionResultV1, SessionInputHandoffCompositionResultV1> = lazyZodSchema(() => z.strictObject({
    kind: z.literal('composed'), destination: z.union([
        z.strictObject({ kind: z.literal('existing'), session: ActionSessionAddressV1Schema }),
        z.strictObject({ kind: z.literal('newSessionDraft') }),
    ]),
}));
export const SessionInputHandoffSessionChoiceV1ProtocolSchema = projectZodProtocolSchema(SessionInputHandoffSessionChoiceV1Schema);
export const SessionInputHandoffDeliveryChoiceV1ProtocolSchema = projectZodProtocolSchema(SessionInputHandoffDeliveryChoiceV1Schema);
export const SessionInputHandoffCompositionResultV1ProtocolSchema = projectZodProtocolSchema(SessionInputHandoffCompositionResultV1Schema);

const handoffSpawn = lazyZodSchema(() => z.safeExtend(SessionSpawnNewActionInputV2Schema, {
    // The handoff admits its content separately after Session creation.
    initialInput: z.optional(z.never()),
}));
export type SessionInputHandoffNewDestinationV1 = Readonly<{
    kind: 'new'; seed: z.input<typeof PluginUiNewSessionSeedV1Schema>; spawn?: z.input<typeof handoffSpawn>;
}>;
export type SessionInputHandoffContentV1 = Readonly<{
    text: string; attachments?: PluginSessionInputAttachmentAuthoringV1[]; forgeEvidence?: SessionInputForgeEvidenceV1;
}>;
export type SessionInputHandoffInputV1 = Readonly<{
    v: 1; sessionChoice: SessionInputHandoffSessionChoiceV1; delivery: 'configured' | 'compose' | 'send';
    defaults?: Readonly<{ destination: Readonly<{ kind: 'existing'; session: SessionTargetV1 }>
        | SessionInputHandoffNewDestinationV1; delivery: 'compose' | 'send' }>;
    newSession?: SessionInputHandoffNewDestinationV1; input: SessionInputHandoffContentV1; idempotencyKey: string;
}>;
export type SessionInputHandoffResultV1 = SessionInputHandoffSendResultV1 | SessionInputHandoffCompositionResultV1
    | Readonly<{ kind: 'authoringResult'; result: SessionAuthoringOpenResultV1 }>
    | Readonly<{ kind: 'creationResult'; result: SessionSpawnNewActionResultV1 }>
    | Readonly<{ kind: 'selectionRequired'; fields: ('sessionChoice' | 'delivery' | 'placement')[] }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'failed'; phase: 'compose' | 'create' | 'send'; failure: ActionExecuteFailure }>
    | Readonly<{ kind: 'approvalPending'; phase: 'compose' | 'create' | 'send'; result: ActionApprovalRequestCreatedResult }>
    | Readonly<{ kind: 'unavailable'; reason: 'composerUnavailable' | 'configuredDestinationUnavailable' }>;

const newDestination = lazyZodSchema(() => z.strictObject({
    kind: z.literal('new'), seed: PluginUiNewSessionSeedV1Schema, spawn: z.optional(handoffSpawn),
}));
export const SessionInputHandoffInputV1Schema: z.ZodMiniType<SessionInputHandoffInputV1, SessionInputHandoffInputV1> = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), sessionChoice: SessionInputHandoffSessionChoiceV1Schema, delivery: SessionInputHandoffDeliveryChoiceV1Schema,
    defaults: z.optional(z.strictObject({ destination: z.union([
        z.strictObject({ kind: z.literal('existing'), session: SessionTargetV1Schema }), newDestination,
    ]), delivery: z.enum(['compose', 'send']) })),
    newSession: z.optional(newDestination),
    input: z.strictObject({ text: z.string(), attachments: z.optional(PluginSessionInputAttachmentsV1Schema),
        forgeEvidence: z.optional(asProtocolZod(SessionInputForgeEvidenceV1Schema)) }).check(z.superRefine(requireSessionInputContent)),
    idempotencyKey: PluginSessionInputIdempotencyKeyV1Schema,
}));
const sessionInputHandoffResultV1Schema = lazyZodSchema(() => z.union([
    SessionInputHandoffSendResultV1Schema, SessionInputHandoffCompositionResultV1Schema,
    z.strictObject({ kind: z.literal('authoringResult'), result: SessionAuthoringOpenResultV1Schema }),
    z.strictObject({ kind: z.literal('creationResult'), result: SessionSpawnNewActionResultV1Schema }),
    z.strictObject({ kind: z.literal('selectionRequired'), fields: z.array(z.enum(['sessionChoice', 'delivery', 'placement'])) }),
    z.strictObject({ kind: z.literal('cancelled') }),
    z.strictObject({ kind: z.literal('failed'), phase: z.enum(['compose', 'create', 'send']), failure: ActionExecuteFailureSchema }),
    z.strictObject({ kind: z.literal('approvalPending'), phase: z.enum(['compose', 'create', 'send']), result: ActionApprovalRequestCreatedResultSchema }),
    z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['composerUnavailable', 'configuredDestinationUnavailable']) }),
]));
export const SessionInputHandoffResultV1Schema: z.ZodMiniType<SessionInputHandoffResultV1, z.input<typeof sessionInputHandoffResultV1Schema>> = sessionInputHandoffResultV1Schema;
