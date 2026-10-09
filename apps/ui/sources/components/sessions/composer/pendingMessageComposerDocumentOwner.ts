import type { ComposerCapabilitiesV1, ComposerRefV1 } from '@happier-dev/protocol';
import type { PendingMessageWithdrawOutcomeV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { SessionPendingWithdrawInputV1 } from '@happier-dev/protocol/sessions/control/pendingWithdrawV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { createDefaultActionExecutor, UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { awaitActionApprovalResult, createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionPendingWithdrawResultV1Schema } from '@happier-dev/protocol/sessions/control/pendingWithdrawV1';

import {
    createEphemeralComposerDocumentOwner,
    type ComposerDraftDocument,
    type MutableComposerDocumentOwner,
    type ComposerDocumentOwner,
} from './composerDocumentOwner';
import { composerAttachmentDraftToView, composerReferencesFromStructuredMentions } from './composerScopeAdapters';

const CAPABILITIES: ComposerCapabilitiesV1 = Object.freeze({
    text: true,
    references: true,
    attachments: true,
    submit: true,
});

export function createPendingMessageComposerDocumentOwner(input: Readonly<{
    ref: Extract<ComposerRefV1, { kind: 'pendingMessage' }>;
    initialDocument: ComposerDraftDocument;
    isCurrent: () => boolean;
}>): MutableComposerDocumentOwner {
    return createEphemeralComposerDocumentOwner({
        ref: input.ref,
        capabilities: CAPABILITIES,
        initialDocument: input.initialDocument,
        isCurrent: input.isCurrent,
    });
}

export type PendingMessageWithdrawRecoveryResult = Readonly<{
    outcome: PendingMessageWithdrawOutcomeV1;
    status: 'restored' | 'not_removed' | 'context_retired' | 'composer_changed';
}>;

/** Withdrawal settles pending custody first; the incumbent Composer transaction owns recovery. */
export async function withdrawPendingMessageToComposer(input: Readonly<{
    composer: ComposerDocumentOwner;
    document: ComposerDraftDocument;
    isCurrent: () => boolean;
    withdraw: () => Promise<PendingMessageWithdrawOutcomeV1>;
}>): Promise<PendingMessageWithdrawRecoveryResult> {
    if (!input.isCurrent()) return { outcome: 'delivery_unknown', status: 'context_retired' };
    const revision = input.composer.read().revision;
    const outcome = await input.withdraw();
    if (outcome !== 'removed') return { outcome, status: 'not_removed' };
    if (!input.isCurrent()) return { outcome, status: 'context_retired' };
    const result = input.composer.apply(revision, {
        text: input.document.text,
        references: composerReferencesFromStructuredMentions({
            text: input.document.text,
            mentions: input.document.structuredInputMentions,
        }),
        attachments: input.document.composerAttachments.map((attachment) => composerAttachmentDraftToView(attachment, { entriesById: null })),
    });
    return {
        outcome,
        status: result.status === 'applied' ? 'restored'
            : result.status === 'composerUnavailable' ? 'context_retired' : 'composer_changed',
    };
}

export type PendingMessageApprovalWithdrawalInput = Omit<Parameters<typeof withdrawPendingMessageToComposer>[0], 'withdraw'> & Readonly<{
    actionExecutor: Pick<ReturnType<typeof createDefaultActionExecutor>, 'prepare'>;
    withdrawInput: SessionPendingWithdrawInputV1;
    context: UiActionExecutorContext;
    scope: ServerAccountScope;
    registerApproval: (continuation: ActionApprovalContinuation) => void;
    signal?: AbortSignal;
}>;

export async function withdrawPendingMessageToComposerWithActionApproval(
    input: PendingMessageApprovalWithdrawalInput,
): Promise<PendingMessageWithdrawRecoveryResult> {
    return await withdrawPendingMessageToComposer({ ...input, withdraw: async () => {
        const unknown = (): Readonly<{ outcome: PendingMessageWithdrawOutcomeV1 }> => ({ outcome: 'delivery_unknown' });
        const result = await awaitActionApprovalResult({
            signal: input.signal,
            succeeded: (value: unknown) => {
                const parsed = SessionPendingWithdrawResultV1Schema.safeParse(value);
                return parsed.success ? parsed.data : unknown();
            },
            failed: unknown,
            aborted: unknown,
            execute: async (callbacks) => {
                const prepared = await input.actionExecutor.prepare('session.pending.withdraw', input.withdrawInput, {
                    ...input.context,
                    ...(input.signal ? { signal: input.signal } : {}),
                });
                if (!input.isCurrent() || input.signal?.aborted) return unknown();
                const executed = prepared.kind === 'ready' ? await prepared.invocation.run() : prepared.result;
                if (!executed.ok) return unknown();
                const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(executed.result);
                if (deferred.success) {
                    if (deferred.data.actionId !== 'session.pending.withdraw' || !input.isCurrent()) return unknown();
                    input.registerApproval(createActionApprovalContinuation<unknown, 'session.pending.withdraw'>({
                        artifactId: deferred.data.artifactId,
                        actionId: 'session.pending.withdraw',
                        scope: input.scope,
                        expectedInput: input.withdrawInput,
                        ...(input.context.actionRequestId ? { expectedRequestId: input.context.actionRequestId } : {}),
                        ...(input.signal ? { signal: input.signal } : {}),
                        onSucceeded: callbacks.onApprovalSucceeded,
                        onFailed: callbacks.onApprovalFailed,
                    }));
                    return { approvalPending: true };
                }
                const parsed = SessionPendingWithdrawResultV1Schema.safeParse(executed.result);
                return parsed.success ? parsed.data : unknown();
            },
        });
        return result.outcome;
    } });
}
