import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { supportsMachineOperationProtocolCapabilityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { supportsSessionMessageInputJsonSchema } from '@happier-dev/protocol/actions/actionInputJsonSchemaValidation';
import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import type { readMachineControlTargetForSessionAuthority } from '@/sync/ops/sessionMachineTarget';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { captureLazyActionAccountContext, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { createUiAccountAction } from './accountActionDeps';
import { readSessionMessageInputSchema } from './sessionMessageInputSchema';

export type SessionMessageDelivery = NonNullable<ActionExecutorDeps['sessionSendMessage']>;
export type SessionMessageComposerSubmission = Readonly<{
    sourceComposerRef: import('@happier-dev/protocol/plugins/ui/composerRef').ComposerRefV1;
    isCurrent: () => boolean;
    legacyAttachments?: Readonly<{
      drafts: readonly import('@/components/sessions/attachments/attachmentDraftModel').AttachmentDraft[];
      config: import('@/sync/domains/transfers/ops/uploadSessionAttachment').AttachmentsUploadConfig;
      originalMessage: string;
      onUploadedDraftCheckpoint: (checkpoint: import('@/components/sessions/attachments/uploadAttachmentDraftsToSession').AttachmentTargetUploadedDraftCheckpoint) => Promise<void> | void;
      onUploadedDraftCheckpointStale: (attempt: Readonly<Pick<import('@/components/sessions/attachments/uploadAttachmentDraftsToSession').AttachmentTargetUploadedDraftCheckpoint,
        'target' | 'executionTarget' | 'messageLocalId'>> & Readonly<{
          handles: readonly import('@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1').SessionAttachmentHandleV1[];
        }>) => void;
    }>;
  }>;

/** One Home transport owns delivery, target schema admission and Composer attachment custody. */
export function createSessionMessageDelivery(params: Readonly<{
  account?: LazyActionAccountContext;
  composerSubmission?: SessionMessageComposerSubmission;
  readTarget: (account: LazyActionAccountContext, sessionId: string, signal?: AbortSignal)
    => ReturnType<typeof readMachineControlTargetForSessionAuthority>;
  assertExpectedAccount: (account: Pick<LazyActionAccountContext, 'accountId'>, context?: ActionExecutorContext) => void;
}>): SessionMessageDelivery {
  const accountContext = params.account;
  const composerSubmission = params.composerSubmission;
  const readAccountSessionControlTarget = params.readTarget;
  const assertExpectedActionAccount = params.assertExpectedAccount;
  return async (args) => {
    const { sessionId, serverId, localId, signal } = args;
    const requiresReplyCustody = args.reply === 'wait' || args.reply === 'return' || args.wait === true;
    if (composerSubmission && (!composerSubmission.isCurrent() || signal?.aborted)) {
      return { ok: false, errorCode: 'session_account_scope_retired', error: 'session_account_scope_retired' };
    }
    if (!args.authoredInput) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    // Dispatch has resolved the exact Home. Borrow its Account for
    // reply/input custody; the remote Action still authorizes the
    // resolved target and requester.
    const ownedAccount = !accountContext && serverId
      ? await captureLazyActionAccountContext(serverId, signal) : null;
    const account = accountContext ?? ownedAccount;
    if (!account) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    try {
      if (ownedAccount) assertExpectedActionAccount(account, args.context);
      account.assertCurrent();
      const { session, target } = await readAccountSessionControlTarget(account, sessionId, signal);
      if (!target) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      if (requiresReplyCustody) {
        const machines = await withActionAccountRequestSignal(account, signal, ownedSignal => readMachineRows({
          readTransport: account.readTransport, request: (path, init) => account.request(path, { ...init, signal: ownedSignal }),
          machineIds: [target.machineId], signal: ownedSignal }));
        account.assertCurrent();
        throwIfAborted(signal);
        const row = machines.get(target.machineId);
        const machine = row?.revokedAt === null && row.replacedByMachineId === null ? row : null;
        if (!supportsMachineOperationProtocolCapabilityV1(machine?.operationProtocolCapabilities, 'sessionMessageReply')) {
          return { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
        }
      }
      // Relay the validated authored variant, not its local text/metadata projection.
      let input = { ...args.authoredInput, sessionId };
      const context: ActionExecutorContext = { ...args.context, actionCaller: args.actionCaller ?? args.context.actionCaller,
        serverId: account.serverId, runtimeAccountId: account.accountId,
        externalActionTarget: { kind: 'machine', machineId: target.machineId } };
      const execute = createUiAccountAction({ account });
      // Authenticated receivers strictly parse ordinary Send, including authored
      // metadata and the full model selection. The original Send can therefore
      // reach Home's managed wake without an online descriptor read.
      const requiresTargetInputSchema = requiresReplyCustody || !('message' in input)
        || input.structuredInput !== undefined || input.recipient !== undefined
        || input.idempotencyKey !== undefined || input.forgeEvidence !== undefined
        || args.actionCaller?.kind === 'plugin' || args.sessionInputSource !== undefined
        || args.context.authority === 'account_automation' || composerSubmission?.legacyAttachments !== undefined;
      let advertisedInputSchema: object | undefined;
      if (requiresTargetInputSchema) {
        try {
          advertisedInputSchema = await readSessionMessageInputSchema({ account, session,
            machineId: target.machineId, context, signal });
          account.assertCurrent();
          throwIfAborted(signal);
          if (!supportsSessionMessageInputJsonSchema(advertisedInputSchema, input)) {
            return { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
          }
        } catch {
          throwIfAborted(signal);
          account.assertCurrent();
          return { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
        }
      }
      if (composerSubmission?.legacyAttachments && 'message' in input) {
        if (!localId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        const { uploadSessionMessageAttachmentDrafts } = await import('@/components/sessions/attachments/uploadSessionMessageAttachmentDrafts');
        const uploaded = await uploadSessionMessageAttachmentDrafts({
          target: { serverId: account.serverId, accountId: account.accountId, sessionId },
          executionTarget: { serverId: account.serverId, machineId: target.machineId },
          drafts: composerSubmission.legacyAttachments.drafts, config: composerSubmission.legacyAttachments.config,
          onUploadedDraftCheckpoint: composerSubmission.legacyAttachments.onUploadedDraftCheckpoint,
          messageLocalId: localId, ...(signal ? { signal } : {}),
          isCurrent: () => account.accountLifetime.isCurrent() && composerSubmission.isCurrent(),
        });
        if (!uploaded) return { ok: false, errorCode: 'session_input_target_unavailable', error: 'session_input_target_unavailable' };
        if ('ok' in uploaded) return uploaded;
        const { reconcileBrowserContextPictures } = await import('@/sync/domains/session/input/browserContext');
        input = { ...input, message: composerSubmission.legacyAttachments.originalMessage,
          structuredInput: { v: 1, ...input.structuredInput, sessionAttachments: uploaded.map(attachment => attachment.attachmentHandle),
            ...(input.structuredInput?.browserContext ? { browserContext: reconcileBrowserContextPictures(input.structuredInput.browserContext, uploaded) } : {}) } };
      }
      let preparedAttachments: Awaited<ReturnType<typeof import('@/sync/domains/transfers/ops/prepareTargetComposerAttachments').prepareTargetComposerAttachments>> = null;
      if (composerSubmission && 'message' in input && input.structuredInput?.composerAttachments?.length) {
        if (!localId || !composerSubmission.isCurrent() || signal?.aborted) {
          return { ok: false, errorCode: 'session_account_scope_retired', error: 'session_account_scope_retired' };
        }
        const { prepareTargetComposerAttachments } = await import('@/sync/domains/transfers/ops/prepareTargetComposerAttachments');
        preparedAttachments = await prepareTargetComposerAttachments({
          attachments: input.structuredInput.composerAttachments,
          sourceComposerRef: composerSubmission.sourceComposerRef,
          targetComposerRef: { kind: 'session', sessionId },
          executionTarget: { serverId: account.serverId, machineId: target.machineId },
          messageLocalId: localId, signal, isCurrent: () => account.accountLifetime.isCurrent() && composerSubmission.isCurrent(),
        });
        if (!preparedAttachments) return { ok: false, errorCode: 'session_input_target_unavailable', error: 'session_input_target_unavailable' };
        const { RawIngressStructuredInputV1Schema } = await import('@happier-dev/protocol/runtime/input/structuredInputV1');
        input = { ...input, structuredInput: RawIngressStructuredInputV1Schema.parse({
          ...input.structuredInput, composerAttachments: preparedAttachments.attachments,
        }) };
        if (!composerSubmission.isCurrent() || !account.accountLifetime.isCurrent() || signal?.aborted) {
          await preparedAttachments.releaseOnRejection();
          return { ok: false, errorCode: 'session_account_scope_retired', error: 'session_account_scope_retired' };
        }
      }
      if (advertisedInputSchema && !supportsSessionMessageInputJsonSchema(advertisedInputSchema, input)) {
        await preparedAttachments?.releaseOnRejection();
        return { ok: false, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
      }
      const result = await execute({ actionId: 'session.message.send', input, context, ...(signal ? { signal } : {}) });
      const failure = ActionExecuteFailureSchema.safeParse(result);
      if (failure.success && failure.data.errorCode === 'session_attachment_upload_checkpoint_stale'
        && composerSubmission?.legacyAttachments && localId && 'message' in input) {
        composerSubmission.legacyAttachments.onUploadedDraftCheckpointStale({
          target: { serverId: account.serverId, accountId: account.accountId, sessionId },
          executionTarget: { serverId: account.serverId, machineId: target.machineId }, messageLocalId: localId,
          handles: input.structuredInput?.sessionAttachments ?? [],
        });
        await preparedAttachments?.releaseOnRejection();
        return result;
      }
      const { SessionMessageSendResultV1Schema } = await import('@happier-dev/protocol/sessions/messages/sessionInputAdmission');
      const receipt = SessionMessageSendResultV1Schema.safeParse(result);
      if (preparedAttachments && receipt.success && (receipt.data.status === 'rejected'
        || receipt.data.status === 'alreadyAccepted' || receipt.data.status === 'replied')) {
        await preparedAttachments.releaseOnRejection();
      }
      return result;
    } finally {
      ownedAccount?.dispose();
    }
  };
}
