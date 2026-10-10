import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Modal } from '@/modal';
import { ArtifactActionOutputSchemasV1, type ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactOrganizationMutationFailureV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { duplicatePromptBundle } from '@/sync/ops/promptLibrary/promptBundles';
import { duplicatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { t } from '@/text';

import { buildPromptAssetExportHref } from '../shared/buildPromptAssetExportHref';
import { promptCollectionItemHref } from './promptCollectionModel';

/**
 * The rare operations on a saved prompt or skill, offered by its editor's `⋯` menu: duplicate it
 * (opening the copy), manage where it is exported, and delete it after confirmation.
 * References stay authoritative: a required missing document must be explicitly repaired or detached.
 */
export function usePromptLibraryEntryActions(kind: 'doc' | 'bundle', requestedScope?: ServerAccountScope | null,
    review?: Readonly<{ expectedRevision?: ArtifactRevisionV1; assertCurrent?(): void }>) {
    const router = useRouter();
    const activeScope = useAccountSettingsScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;

    /** Resolves `true` once the item is gone, so its editor can leave. */
    const remove = React.useCallback(async (artifactId: string): Promise<boolean> => {
        const confirmed = await Modal.confirm(
            t('promptLibrary.deleteLibraryItemTitle'),
            t('promptLibrary.deleteLibraryItemBody'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return false;

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
            const executor = createDefaultActionExecutor();
            const actionContext = { serverId: context.serverId, surface: 'ui' as const, authority: 'present_user' as const, signal: controller.signal };
            let expectedRevision = review?.expectedRevision;
            if (!expectedRevision) {
                const opened = await executor.execute('artifact.get', { artifactId }, actionContext);
                if (!opened.ok) throw new Error(opened.errorCode);
                const document = ArtifactActionOutputSchemasV1['artifact.get'].parse(opened.result).artifact;
                if (!document) throw new Error('not_found');
                expectedRevision = document.revision;
            }
            context.assertCurrent();
            review?.assertCurrent?.();
            const deleted = await executor.execute('artifact.delete', { artifactId, expectedRevision }, actionContext);
            if (!deleted.ok) throw new Error(deleted.errorCode);
            ArtifactActionOutputSchemasV1['artifact.delete'].parse(deleted.result);
            return true;
        } catch {
            Modal.alert(t('common.error'), t('errors.unknownError'));
            return false;
        } finally { retirement?.dispose(); context?.dispose(); }
    }, [accountId, serverId, review?.assertCurrent, review?.expectedRevision]);

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
            const nextArtifactId = kind === 'doc'
                ? await duplicatePromptDoc(artifactId, { serverId: context.serverId, signal: controller.signal })
                : await duplicatePromptBundle(artifactId, { serverId: context.serverId, signal: controller.signal });
            context.assertCurrent();
            review?.assertCurrent?.();
            router.push(promptCollectionItemHref(kind, nextArtifactId, { serverId }) as never);
        } catch (error) {
            if (error instanceof ArtifactOrganizationMutationFailureV1 && context) {
                try {
                    context.assertCurrent();
                    review?.assertCurrent?.();
                    router.push(promptCollectionItemHref(kind, error.details.artifactId, { serverId: context.serverId }) as never);
                } catch { /* A retired captured Home cannot adopt the copied Artifact. */ }
            }
            Modal.alert(t('common.error'), t('errors.unknownError'));
        } finally { retirement?.dispose(); context?.dispose(); }
    }, [kind, router, serverId, accountId, review?.assertCurrent]);

    const manageExternalAssets = React.useCallback((artifactId: string) => {
        if (!serverId) return;
        router.push(buildPromptAssetExportHref({ artifactId, libraryKind: kind, serverId }) as never);
    }, [kind, router, serverId]);

    return { remove, duplicate, manageExternalAssets } as const;
}
