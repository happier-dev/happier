import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import { flushAttachmentDraftsForKey, getAttachmentDraftsSnapshotForKey, patchAttachmentDraftForKey, settleAttachmentDraftsForKey } from '@/components/sessions/attachments/attachmentDraftMemoryStore';
import { resolveSessionAttachmentDraftScope, sessionAttachmentDraftKey } from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import { captureSessionMessageAttachmentDrafts, isAttachmentTargetUploadCheckpointFor,
    recordAttachmentTargetUploadCheckpoint } from '@/components/sessions/attachments/uploadSessionMessageAttachmentDrafts';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { buildStructuredInputMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import { RawIngressStructuredInputV1Schema } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { AgentInputSendOptions } from '@/components/sessions/agentInput';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readSessionComposerPresentationTargetAtAddress } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { createExistingSessionComposerDocumentOwner } from './existingSessionComposerDocumentOwner';
import { captureSessionDraftCurrentness, clearSessionMessagingDraftMutationAttempt, flushSessionDraftLocally,
    getOrCreateSessionMessagingDraftMutationAttempt } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { resolveAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { sendableAttachmentDrafts } from '@/components/sessions/attachments/attachmentDraftModel';
import { captureSessionComposerMessageAttachments, readSessionComposerMessageAdmission,
    type AdmittedSessionComposerMessageResult } from './sessionComposerMessaging';

export type SessionDraftSubmitResult = ActionExecuteFailure | Readonly<{ ok: true; result: AdmittedSessionComposerMessageResult }>;

export function readSessionDraftSubmitResult(result: ActionExecuteResult): SessionDraftSubmitResult {
    if (!result.ok) return result;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return { ok: false, errorCode: approval.data.kind, error: approval.data.kind, details: approval.data };
    const admission = readSessionComposerMessageAdmission(result.result);
    return admission.kind === 'accepted' ? { ok: true, result: admission.receipt }
        : { ok: false, errorCode: admission.code, error: admission.code };
}

/** Mounted and offscreen submission retain target uploads on the same attachment owner. */
export function createSessionDraftMessageExecute(input: Readonly<{
    sessionTarget: ExactSessionMachineTargetIdentity;
    sourceComposerRef: ComposerRefV1;
    drafts: readonly AttachmentDraft[];
    config: AttachmentsUploadConfig;
    originalMessage: string;
    isCurrent: () => boolean;
    signal?: AbortSignal;
}>) {
    const key = sessionAttachmentDraftKey(resolveSessionAttachmentDraftScope(input.sessionTarget));
    const currentDraft = (submitted: AttachmentDraft) => getAttachmentDraftsSnapshotForKey(key)
        .find(draft => draft.id === submitted.id && draft.source === submitted.source);
    const isCurrent = () => input.isCurrent() && !input.signal?.aborted;
    return createFrontDoorActionExecute(undefined, { sessionMessageComposerSubmission: {
        sourceComposerRef: input.sourceComposerRef, isCurrent,
        ...(input.drafts.length > 0 ? { legacyAttachments: {
            drafts: captureSessionMessageAttachmentDrafts(input.drafts), config: input.config, originalMessage: input.originalMessage,
            onUploadedDraftCheckpoint: checkpoint => {
                if (!isCurrent()) return;
                const submitted = input.drafts.find(draft => draft.id === checkpoint.id);
                const current = submitted && currentDraft(submitted);
                if (current) patchAttachmentDraftForKey(key, current.id, { targetUploadedCheckpoints:
                    recordAttachmentTargetUploadCheckpoint(current.targetUploadedCheckpoints, checkpoint) }, current.source);
            },
            onUploadedDraftCheckpointStale: stale => {
                if (!isCurrent()) return;
                const attemptedIds = new Set(stale.handles.map(handle => handle.id));
                for (const submitted of input.drafts) {
                    const current = currentDraft(submitted);
                    if (!current) continue;
                    const previous = current.targetUploadedCheckpoints ?? [];
                    const retained = previous.filter(checkpoint =>
                        !isAttachmentTargetUploadCheckpointFor(checkpoint, stale.target, stale.messageLocalId, stale.executionTarget)
                        || !checkpoint.attachmentHandle || !attemptedIds.has(checkpoint.attachmentHandle.id));
                    if (retained.length !== previous.length) patchAttachmentDraftForKey(key, current.id,
                        { targetUploadedCheckpoints: retained }, current.source);
                }
            },
        } } : {}),
    }, ...(input.signal ? { hostActionApprovalLifetime: { actionId: 'session.message.send', signal: input.signal, surface: 'ui' } } : {}) });
}

/** Submit the target's whole draft; a failed attempt never appends or discards its sources. */
export async function submitSessionDraft(input: Readonly<{
    sessionTarget: ExactSessionMachineTargetIdentity;
    sendOptions?: AgentInputSendOptions;
    signal?: AbortSignal;
}>): Promise<SessionDraftSubmitResult> {
    const { sessionTarget, signal } = input;
    await flushAttachmentDraftsForKey(sessionAttachmentDraftKey(resolveSessionAttachmentDraftScope(sessionTarget)));
    const mounted = readSessionComposerPresentationTargetAtAddress(sessionTarget);
    if (mounted?.submitDraft && areServerAccountScopesEqual(mounted.readScope?.(), sessionTarget)) {
        return readSessionDraftSubmitResult(await mounted.submitDraft(input.sendOptions));
    }
    const account = await captureLazyActionAccountContext(sessionTarget.serverId, signal);
    try {
        if (!areServerAccountScopesEqual(account.accountLifetime.scope, sessionTarget)) {
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        const isCurrent = () => account.accountLifetime.isCurrent() && !signal?.aborted;
        const sourceComposerRef = { kind: 'session', sessionId: sessionTarget.sessionId } as const;
        const owner = createExistingSessionComposerDocumentOwner({ scope: sessionTarget, ref: sourceComposerRef, isCurrent });
        const document = owner.read().document;
        const currentness = owner.captureCurrentness();
        const key = sessionAttachmentDraftKey(resolveSessionAttachmentDraftScope(sessionTarget));
        const drafts = sendableAttachmentDrafts(getAttachmentDraftsSnapshotForKey(key));
        const attempt = getOrCreateSessionMessagingDraftMutationAttempt({ scope: sessionTarget, sessionId: sessionTarget.sessionId,
            currentness: captureSessionDraftCurrentness({ scope: sessionTarget, address: sourceComposerRef }),
            intent: { kind: 'send', target: sessionTarget.sessionId } });
        if (!attempt) return { ok: false, errorCode: 'session_input_target_unavailable', error: 'session_input_target_unavailable' };
        const meta = buildStructuredInputMetaOverrides({ text: document.text, mentions: document.structuredInputMentions,
            composerAttachments: document.composerAttachments });
        const authoredStructuredInput = RawIngressStructuredInputV1Schema.parse(meta.happierStructuredInputV1 ?? { v: 1 });
        const structuredInput = { ...authoredStructuredInput, ...(drafts.length > 0 ? { sessionAttachments: [] } : {}) };
        const captured = await captureSessionComposerMessageAttachments({ structuredInput, sourceComposerRef,
            messageLocalId: attempt.localId, signal, isCurrent });
        if (!captured) return { ok: false, errorCode: 'session_input_target_unavailable', error: 'session_input_target_unavailable' };
        try {
            const config = resolveAttachmentsUploadConfig(await account.readSettings());
            const execute = createSessionDraftMessageExecute({ sessionTarget, sourceComposerRef, drafts, config,
                originalMessage: document.text, isCurrent, signal });
            await flushSessionDraftLocally({ scope: sessionTarget });
            const result = readSessionDraftSubmitResult(await execute('session.message.send', {
                sessionId: sessionTarget.sessionId, message: document.text, localId: attempt.localId,
                requestedAction: { v: 1, kind: 'send_now' }, reply: 'none', structuredInput: captured.structuredInput,
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: sessionTarget.serverId, expectedAccountId: sessionTarget.accountId, signal }));
            if (result.ok && isCurrent()) {
                owner.clearAccepted(currentness);
                settleAttachmentDraftsForKey(key, drafts);
                clearSessionMessagingDraftMutationAttempt({ scope: sessionTarget, sessionId: sessionTarget.sessionId, localId: attempt.localId });
            }
            return result;
        } finally { await captured.releaseSnapshots(); }
    } finally { account.dispose(); }
}
