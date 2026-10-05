import {
    ComposerAttachmentsPickInputV1Schema,
    ComposerTransactionApplyInputV1Schema,
    RepositoryUploadPickInputV1Schema,
    type ActionExecutorContext,
} from '@happier-dev/protocol';
import {
    applyMountedComposerPresentationTransaction,
    requestRegisteredComposerAttachmentPicker,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { invokeRepositoryUploadPick } from '@/components/workspaces/files/repositoryTree/repositoryUploadActionRuntime';
import { areServerAccountScopesEqual, createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export async function executeComposerIngressAction(request: Readonly<{
    actionId: 'composer.transaction.apply' | 'composer.attachments.pick' | 'repository.upload.pick';
    input: unknown;
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>): Promise<unknown> {
    const signal = request.signal ? { signal: request.signal } : {};
    const scope = createServerAccountScope(request.context.serverId, request.context.runtimeAccountId);
    switch (request.actionId) {
        case 'composer.transaction.apply': {
            const input = ComposerTransactionApplyInputV1Schema.parse(request.input);
            if (!areServerAccountScopesEqual(scope, input.scope)) return { status: 'composerUnavailable' };
            return applyMountedComposerPresentationTransaction({ ...input, ...signal });
        }
        case 'composer.attachments.pick': {
            const input = ComposerAttachmentsPickInputV1Schema.parse(request.input);
            if (!areServerAccountScopesEqual(scope, input.scope)) return { status: 'unavailable' };
            return requestRegisteredComposerAttachmentPicker({ ...input, ...signal });
        }
        case 'repository.upload.pick': {
            const input = RepositoryUploadPickInputV1Schema.parse(request.input);
            if (!areServerAccountScopesEqual(scope, input.scope)) return { status: 'unavailable' };
            return invokeRepositoryUploadPick(input, request.signal);
        }
    }
}
