import * as React from 'react';
import { ArtifactFolderMutationResultV1Schema } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import type { ArtifactFolderActionIdV1 } from '@happier-dev/protocol/prompts/library/artifactFolderActionIdsV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifacts } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { projectArtifactBrowserTree, type ArtifactBrowserFilter } from './artifactBrowserModel';

/** One narrow catalog subscription; views project the same tree rather than owning folder grouping. */
export function useArtifactBrowserTree(filter: ArtifactBrowserFilter, collapsedFolderIds?: ReadonlySet<string>,
    /** A surface already holding the Artifacts it lists (a fixture page) passes them; the store is the default. */
    listed?: readonly DecryptedArtifact[]) {
    const stored = useArtifacts(listed ? 'none' : filter.kind === 'prompt' ? 'promptLibrary' : 'browserListed');
    const artifacts = listed ?? stored;
    const catalog = usePromptLibraryCatalogValue('folders');
    const tree = React.useMemo(() => projectArtifactBrowserTree(artifacts, filter,
        { folders: catalog.value, collapsedFolderIds }), [artifacts, filter, catalog.value, collapsedFolderIds]);
    return { tree, catalog, canWrite: catalog.status === 'ready' && !catalog.stale && catalog.value !== null };
}

/** Current Home and expected row revision are captured at invocation, never inferred from Artifact access. */
export function useArtifactFolderActions() {
    const scope = useAccountSettingsScope();
    const catalog = usePromptLibraryCatalogValue('folders');
    const executor = React.useMemo(() => createDefaultActionExecutor(), []);
    const canWrite = Boolean(scope) && catalog.status === 'ready' && !catalog.stale && catalog.value !== null;
    const execute = React.useCallback(async (actionId: ArtifactFolderActionIdV1, input: Readonly<Record<string, unknown>>) => {
        if (!scope || !canWrite) throw new HappyError('Artifact folder catalog is unavailable', false, { code: 'catalog-unavailable' });
        const receipt = await executor.execute(actionId, { expectedRevision: catalog.revision, ...input },
            { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId }).catch((error: unknown) => {
                if (error instanceof Error && !(error instanceof HappyError) && 'code' in error && typeof error.code === 'string')
                    throw new HappyError(error.message, false, { code: error.code });
                throw error;
            });
        requireActionSuccess(receipt);
        // An approval-request receipt is not a durable folder mutation.
        const mutation = ArtifactFolderMutationResultV1Schema.parse(receipt.result);
        if (mutation.status !== 'updated') throw new HappyError(mutation.status, false, {
            code: mutation.status === 'conflict' ? 'revision-conflict' : mutation.reason, details: mutation,
        });
        return mutation;
    }, [scope, canWrite, catalog.revision, executor]);
    return { catalog, canWrite, execute };
}
