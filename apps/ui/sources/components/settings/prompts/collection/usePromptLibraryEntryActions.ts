import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Modal } from '@/modal';
import { ArtifactActionOutputSchemasV1, type ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactOrganizationMutationFailureV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createActionExecuteFailureError, isActionApprovalDeclinedErrorCode, parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { duplicatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { t } from '@/text';

import { promptCollectionItemHref } from './promptCollectionModel';

function alertPromptEntryActionFailure(error: unknown): void {
    Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(parseActionExecuteFailure(error) ?? error, t('errors.unknownError')));
}

/**
 * The rare operations on a saved prompt, offered by its editor's `⋯` menu: duplicate it
 * (opening the copy), export its saved content, and delete it through the Action's approval policy.
 * References stay authoritative: a required missing document must be explicitly repaired or detached.
 */
export function usePromptLibraryEntryActions(requestedScope?: ServerAccountScope | null,
    review?: Readonly<{ expectedRevision?: ArtifactRevisionV1; assertCurrent?(): void }>) {
    const router = useRouter();
    const activeScope = useAccountSettingsScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const { execute, isCurrent } = useMountedActionExecution(scope);

    /** Resolves `true` once the item is gone, so its editor can leave. */
    const remove = React.useCallback(async (artifactId: string): Promise<boolean> => {
        if (!serverId || !accountId) {
            Modal.alert(t('common.error'), t('errors.unknownError'));
            return false;
        }

        let context: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        const controller = new AbortController();
        let retirement: Readonly<{ dispose(): void }> | undefined;
        try {
            review?.assertCurrent?.();
            context = await captureLazyActionAccountContext(serverId);
            if (context.accountId !== accountId) throw new Error('action_account_scope_changed');
            retirement = context.accountLifetime.onRetire(() => controller.abort());
            const actionContext = { signal: controller.signal };
            let expectedRevision = review?.expectedRevision;
            if (!expectedRevision) {
                const opened = await execute('artifact.get', { artifactId }, actionContext);
                if (!opened.ok) throw createActionExecuteFailureError(opened);
                const document = ArtifactActionOutputSchemasV1['artifact.get'].parse(opened.result).artifact;
                if (!document) throw new Error('not_found');
                expectedRevision = document.revision;
            }
            context.assertCurrent();
            review?.assertCurrent?.();
            const deleted = await execute('artifact.delete', { artifactId, expectedRevision }, actionContext);
            if (!deleted.ok && isActionApprovalDeclinedErrorCode(deleted.errorCode)) return false;
            if (!deleted.ok) throw createActionExecuteFailureError(deleted);
            ArtifactActionOutputSchemasV1['artifact.delete'].parse(deleted.result);
            context.assertCurrent();
            review?.assertCurrent?.();
            return true;
        } catch (error) {
            if (isCurrent() && !controller.signal.aborted) alertPromptEntryActionFailure(error);
            return false;
        } finally { retirement?.dispose(); context?.dispose(); }
    }, [accountId, serverId, execute, isCurrent, review?.assertCurrent, review?.expectedRevision]);

    const duplicate = React.useCallback(async (artifactId: string) => {
        let context: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        const controller = new AbortController();
        let retirement: Readonly<{ dispose(): void }> | undefined;
        try {
            review?.assertCurrent?.();
            if (!serverId || !accountId) throw new Error('action_account_scope_changed');
            context = await captureLazyActionAccountContext(serverId);
            if (context.accountId !== accountId) throw new Error('action_account_scope_changed');
            retirement = context.accountLifetime.onRetire(() => controller.abort());
            const nextArtifactId = await duplicatePromptDoc(artifactId, { serverId: context.serverId, expectedAccountId: context.accountId,
                signal: controller.signal, executeAction: execute });
            context.assertCurrent();
            review?.assertCurrent?.();
            router.push(promptCollectionItemHref('doc', nextArtifactId, { serverId }) as never);
        } catch (error) {
            if (error instanceof ArtifactOrganizationMutationFailureV1 && context) {
                try {
                    context.assertCurrent();
                    review?.assertCurrent?.();
                    router.push(promptCollectionItemHref('doc', error.details.artifactId, { serverId: context.serverId }) as never);
                } catch { /* A retired captured Home cannot adopt the copied Artifact. */ }
            }
            if (isCurrent() && !controller.signal.aborted) alertPromptEntryActionFailure(error);
        } finally { retirement?.dispose(); context?.dispose(); }
    }, [router, serverId, accountId, execute, isCurrent, review?.assertCurrent]);

    const exportDocument = React.useCallback(async (artifactId: string) => {
        try {
            review?.assertCurrent?.();
            const result = await execute('artifact.export', { artifactId, destination: 'client' });
            if (!result.ok && isActionApprovalDeclinedErrorCode(result.errorCode)) return;
            if (!result.ok) throw createActionExecuteFailureError(result);
            ArtifactActionOutputSchemasV1['artifact.export'].parse(result.result);
        } catch (error) {
            if (isCurrent()) alertPromptEntryActionFailure(error);
        }
    }, [execute, isCurrent, review?.assertCurrent]);

    return { remove, duplicate, exportDocument } as const;
}
