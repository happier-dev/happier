import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { openSaveFileAsArtifactDialog } from './SaveFileAsArtifactDialog';
import { useFilePageShareContext } from './useFilePageShareContext';
import { useWorkspaceFileShareActions, type WorkspaceFileShareActionsInput } from './useWorkspaceFileShareActions';

/** Built-in and plugin viewers use the same addressed share and publication composition. */
export function useFilePageSharing(input: Parameters<typeof useFilePageShareContext>[0] & Readonly<{
    machineReachable: boolean;
    unavailableReason: string;
    cachedContent?: WorkspaceFileShareActionsInput['cachedContent'];
    sourceFacts: string;
}>) {
    const router = useRouter();
    const context = useFilePageShareContext(input);
    return useWorkspaceFileShareActions({
        workspaceScope: input.scope, path: input.filePath, actionScope: input.accountScope,
        linkInput: context.linkInput, composer: context.composer, homeDir: context.homeDir,
        machineReachable: input.machineReachable, unavailableReason: input.unavailableReason, cachedContent: input.cachedContent,
        onSaveAsArtifact: input.accountScope ? () => {
            const sourceScope = input.accountScope;
            if (!sourceScope || !areServerAccountScopesEqual(sourceScope, getActiveServerAccountScope())) return;
            openSaveFileAsArtifactDialog({
                source: { scope: sourceScope, sourceSessionId: context.sourceSessionId,
                    sourceWorkspace: context.sourceSessionId ? null : { machineId: input.scope.machineId, rootPath: input.scope.rootPath },
                    sourceProject: context.sourceProject, filePath: input.filePath },
                sourceFacts: input.sourceFacts,
                onOpenArtifact: (artifactId: string) => {
                    if (areServerAccountScopesEqual(sourceScope, getActiveServerAccountScope())) router.push(artifactViewRoute(artifactId) as never);
                },
            });
        } : undefined,
    });
}
