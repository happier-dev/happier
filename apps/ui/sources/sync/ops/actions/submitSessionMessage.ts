import { createFrontDoorActionExecute, requireActionSuccess } from './frontDoorRuntimeActionExecutor';
import { completeActionResult } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readSessionMessageModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { buildOutgoingUserTextRecord } from '@/sync/domains/messages/outgoingUserMessage';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { HappyError } from '@/utils/errors/errors';
import { projectServerScopedSessionSendMessageResult } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage';
import { projectHeldSessionInputReceipt, submitSessionUserMessage } from '@/sync/domains/session/input/submitSessionUserMessage';
import type { SessionSubmitPort, SubmitSessionUserMessageOptions, SubmitSessionUserMessageResult } from '@/sync/domains/session/input/types';
import type { SessionMessageDelivery } from './sessionMessageDelivery';

/** The admitted domain submit owner chooses mode/interrupt; Home owns every resulting delivery effect. */
function createHomeDeliverySubmitPort(port: SessionSubmitPort, args: Parameters<SessionMessageDelivery>[0],
    delivery: SessionMessageDelivery): SessionSubmitPort {
    const send = async (sessionId: string, text: string, displayText: string | undefined,
        messageMeta: Record<string, unknown> | undefined,
        requestedAction: Parameters<SessionMessageDelivery>[0]['requestedAction'], localId?: string | null) => {
        if (!args.authoredInput || !('message' in args.authoredInput)) throw new HappyError('Invalid message input', false, { code: 'invalid_parameters' });
        const sent = requireSendSuccess(completeActionResult(await delivery({ ...args, sessionId, message: text,
            displayText, messageMeta: args.messageMeta, requestedAction, localId: localId ?? args.localId,
            authoredInput: { ...args.authoredInput, sessionId, message: text,
                messageMeta: { ...args.authoredInput.messageMeta, ...messageMeta }, requestedAction,
                ...(localId ? { localId } : {}) },
        })));
        if (sent.status === 'outcomeUnknown') throw new HappyError(sent.code, false, { code: sent.code });
        return sent;
    };
    return { ...port,
        // The Home receipt owns activation; the local Pending wake phase consumes that receipt below.
        shouldDelegatePendingActivationToDaemon: undefined,
        enqueuePendingMessage: async (sessionId, text, displayText, meta, options) => {
            const sent = await send(sessionId, text, displayText, { ...args.messageMeta, ...meta },
                options?.requestedAction, options?.localId);
            return sent;
        },
        sendMessage: async (sessionId, text, displayText, meta, options) => {
            const sent = await send(sessionId, text, displayText, { ...args.messageMeta, ...meta },
                { v: 1, kind: 'send_now' }, options?.localId);
            return { ...sent, persistence: 'pending' };
        },
    };
}

function requireSendSuccess(result: ActionExecuteResult) {
    requireActionSuccess(result);
    if (!result.ok) throw new Error('Unreachable Action refusal');
    const sent = SessionMessageSendResultV1Schema.parse(result.result);
    if (sent.status === 'rejected' || sent.status === 'failed' || sent.status === 'cancelled') {
        throw new HappyError(sent.code, false, { code: sent.code, details: sent });
    }
    return sent;
}

/** Composer and option-chip Send share Action admission; the incumbent submit owner keeps delivery and draft custody. */
export async function submitUiSessionMessage(port: SessionSubmitPort, options: SubmitSessionUserMessageOptions): Promise<SubmitSessionUserMessageResult> {
    const surface = options.actionContext?.surface ?? (options.hostAdmissionOrigin === 'voice' ? 'voice' : 'ui');
    let submitted: SubmitSessionUserMessageResult | undefined;
    const execute = createFrontDoorActionExecute(undefined, {
        sessionMessageAuthoringInput: settings => {
            const record = buildOutgoingUserTextRecord({ text: options.text, displayText: options.displayText,
                session: options.session, permissionMode: options.session.permissionMode ?? 'default',
                modelMode: options.session.modelMode, agentId: readSessionPresentationAgentId(options.session),
                settings: settings ?? options.resumeCapabilityOptions.accountSettings ?? {}, metaOverrides: options.metaOverrides,
                allowedModels: options.allowedModels, allowedPermissionModes: options.allowedPermissionModes,
                ...(options.hostAdmissionOrigin ? { hostAdmissionOrigin: options.hostAdmissionOrigin } : {}) });
            const selection = readSessionMessageModelSelectionV1(record.meta);
            if (selection.status === 'invalid') throw new HappyError('Invalid model selection', false, { code: 'invalid_parameters' });
            return {
                sessionId: options.sessionId, message: options.text,
                ...(options.metaOverrides?.happierStructuredInputV1 !== undefined ? { structuredInput: options.metaOverrides.happierStructuredInputV1 } : {}),
                messageMeta: record.meta,
                ...(record.meta?.permissionMode ? { permissionModeOverride: record.meta.permissionMode } : {}),
                ...(selection.status === 'valid' ? { modelSelection: selection.selection }
                    : typeof record.meta?.model === 'string' || record.meta?.model === null ? { modelOverride: record.meta.model } : {}),
                ...(options.localId ? { localId: options.localId } : {}),
                ...(options.recipient ? { recipient: options.recipient } : {}),
                ...(options.requestedAction ? { requestedAction: options.requestedAction } : {}),
            };
        },
        sessionSendMessage: async (args, delivery) => {
            const { permissionModeOverride, context } = args;
            const submitPort = delivery ? createHomeDeliverySubmitPort(port, args, delivery) : port;
            submitted = await submitSessionUserMessage(submitPort, { ...options, actionContext: context,
                metaOverrides: permissionModeOverride
                    ? { ...options.metaOverrides, permissionMode: permissionModeOverride }
                    : options.metaOverrides,
            });
            if (submitted.type === 'send_failed' || submitted.type === 'wake_failed' || submitted.type === 'rejected') {
                throw new HappyError(submitted.errorMessage ?? submitted.type, false, { code: submitted.errorCode ?? submitted.type });
            }
            return projectServerScopedSessionSendMessageResult({ ok: true, ack: {
                localId: submitted.localId,
                accepted: submitted.type === 'success' && submitted.providerAcceptancePending !== true,
            } });
        },
    });
    const execution = await execute('session.message.send', {
        sessionId: options.sessionId, message: options.text,
    }, { ...options.actionContext, surface, defaultSessionId: options.sessionId, ...(options.serverId ? { serverId: options.serverId } : {}) });
    // An admitted local effect retains the submit owner's failure/custody result.
    // Admission refusals still throw below because no local effect ran.
    if (submitted && (submitted.type === 'send_failed' || submitted.type === 'wake_failed' || submitted.type === 'rejected')) return submitted;
    const sent = requireSendSuccess(execution);
    if (submitted) return submitted;
    // API-token clients receive the canonical remote receipt; their callback
    // clears the exact captured draft just as the local submit owner does.
    if (sent.status === 'outcomeUnknown') return { type: 'rejected', persistence: 'none', errorCode: sent.code,
        errorMessage: sent.code, wake: { attempted: false, state: 'not_needed' } };
    options.onOutboundHandoff?.({ persistence: 'pending', localId: sent.localId });
    const held = projectHeldSessionInputReceipt(sent, sent.localId);
    if (held) return held;
    return { type: 'success', persistence: 'pending', localId: sent.localId,
        wake: { attempted: false, state: 'not_needed' } };
}
