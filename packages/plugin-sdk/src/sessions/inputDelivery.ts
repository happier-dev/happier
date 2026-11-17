import type { ActionExecutionOptions } from '../actions/index.js';
import type { PluginActionInputById, PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import { ActionFailureCauseV1Schema, isPluginError, readUnexpectedActionErrorDiagnosticV1 } from '../errors.js';
import type { SessionId } from '../services/sessions.js';
import type { ComposerTransactionV1, PluginUiHostApi } from '../ui/index.js';
import { defineProtocolJsonValue } from '../protocol/protocolFacade.js';
import { sendSessionInputHandoffV1 } from '@happier-dev/protocol/sessions/messages/runSessionInputHandoffV1';

const attachmentJsonValue = defineProtocolJsonValue();

type SendInput = Extract<PluginActionInputById['session.message.send'], Readonly<{ message: string }>>;
export type SessionInputDeliveryPlanV1 =
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'input'; text: string; attachments: NonNullable<SendInput['attachments']>;
        forgeEvidence?: NonNullable<SendInput['forgeEvidence']> }>;

export type SessionInputDeliveryFailureV1 = Readonly<{
    step: 'buildInput' | 'admitAttachment' | 'dispatch' | 'awaitAck';
    errorClass: string | null;
    errorCode: string | null;
}>;

export type SessionInputDeliveryOutcomeV1 = 'none'
    | Extract<PluginActionResultById['session.message.send'], Readonly<{ status: string }>>['status'];
export type SessionInputCompositionPlanV1 = Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'compose'; text?: string; attachments: NonNullable<SendInput['attachments']> }>;

/** Insert an already built domain input into the mounted Session composer.
 * The composer owns revision admission and the resulting editable draft. */
export async function composeSessionInputV1(input: Readonly<{
    host: Partial<Pick<PluginUiHostApi, 'readComposer' | 'applyComposer'>>;
    sessionId: SessionId;
    buildInput(): SessionInputCompositionPlanV1;
    signal?: AbortSignal;
}>): Promise<'composed' | 'composerUnavailable' | 'none'> {
    if (!input.host.readComposer || !input.host.applyComposer) return 'composerUnavailable';
    const ref = { kind: 'session' as const, sessionId: input.sessionId };
    const options = input.signal === undefined ? {} : { signal: input.signal };
    const read = await input.host.readComposer(ref, options).catch(() => null);
    if (read?.status !== 'ready' || !read.snapshot.state.editable) return 'composerUnavailable';
    const plan = input.buildInput();
    if (plan.kind === 'none') return 'none';
    const operations: ComposerTransactionV1['operations'][number][] = [
        ...(plan.text === undefined ? [] : [{ kind: 'text.insert' as const,
            position: { offset: read.snapshot.text.length },
            text: `${read.snapshot.text.length === 0 ? '' : '\n\n'}${plan.text}` }]),
        ...plan.attachments.map(item => ({ kind: 'attachment.add' as const, ...item,
            value: { ...item.value, value: attachmentJsonValue.parse(item.value.value) } })),
    ];
    const applied = await input.host.applyComposer(ref, { expectedRevision: read.snapshot.revision, operations }, options).catch(() => null);
    return applied?.status === 'applied' ? 'composed' : 'composerUnavailable';
}

/** Shared Session delivery phase. The caller retains the identity of the person's
 * press; the Session input owner alone decides admission, idle queueing and recovery.
 * Domain adapters build attachments without owning another send implementation. */
export async function deliverSessionInputV1(input: Readonly<{
    execute: (action: 'session.message.send', value: PluginActionInputById['session.message.send'],
        options?: ActionExecutionOptions) => Promise<PluginActionResultById['session.message.send']>;
    sessionId: SessionId;
    serverId?: string;
    idempotencyKey: string;
    buildInput(): SessionInputDeliveryPlanV1;
    signal?: AbortSignal;
    onResult?: (result: PluginActionResultById['session.message.send']) => void;
    onFailure?: (detail: SessionInputDeliveryFailureV1) => void;
}>): Promise<SessionInputDeliveryOutcomeV1> {
    let step: SessionInputDeliveryFailureV1['step'] = 'buildInput';
    try {
        const plan = input.buildInput();
        if (plan.kind === 'none') return 'none';
        step = 'dispatch';
        const handed = await sendSessionInputHandoffV1({
            session: { sessionId: input.sessionId, ...(input.serverId === undefined ? {} : { serverId: input.serverId }) },
            input: { text: plan.text, attachments: plan.attachments,
                ...(plan.forgeEvidence === undefined ? {} : { forgeEvidence: plan.forgeEvidence }) },
            idempotencyKey: input.idempotencyKey,
        }, { send: async (value, signal) => ({ ok: true, result: await input.execute('session.message.send', {
            sessionId: value.session.sessionId, message: value.input.text, idempotencyKey: value.idempotencyKey,
            ...(value.input.attachments?.length ? { attachments: value.input.attachments } : {}),
            ...(value.input.forgeEvidence === undefined ? {} : { forgeEvidence: value.input.forgeEvidence }),
        }, { ...(signal === undefined ? {} : { signal }),
            ...(value.session.serverId === undefined ? {} : { sessionAddress: {
                serverId: value.session.serverId, sessionId: value.session.sessionId,
            } }),
        }) }) }, input.signal);
        if (handed.kind !== 'sendResult') return 'outcomeUnknown';
        const result = handed.result;
        input.onResult?.(result);
        if ('status' in result && result.status === 'outcomeUnknown') {
            input.onFailure?.({ step: 'awaitAck', errorClass: null, errorCode: result.code ?? null });
        }
        return 'status' in result ? result.status : 'outcomeUnknown';
    } catch (error) {
        const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
        const pluginError = isPluginError(error) ? error : null;
        const cause = ActionFailureCauseV1Schema.safeParse(pluginError?.data.failureCause ?? pluginError?.details);
        input.onFailure?.({ step, errorClass: cause.success ? cause.data.errorClass
            : pluginError ? 'PluginError' : diagnostic.errorClass,
            errorCode: cause.success ? cause.data.errorCode : pluginError?.code ?? diagnostic.errorCode });
        return 'outcomeUnknown';
    }
}
