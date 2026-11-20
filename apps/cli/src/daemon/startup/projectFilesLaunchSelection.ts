import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionProjectFilesV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

/** A null selection keeps the accepted checkout in place. Undefined uses the existing copy default. */
export function resolveProjectFilesForManagedLaunch(input: Readonly<{
    inPlaceWorkspace?: Extract<WorkspaceAddressV2, { kind: 'managed' }>;
    placement?: SessionProjectFilesV1;
    recipe?: SessionProjectFilesV1;
}>): SessionProjectFilesV1 | null | undefined {
    if (input.inPlaceWorkspace) return null;
    const placement = input.placement;
    const recipe = input.recipe;
    if (!placement) return recipe;
    if (placement.kind === 'git_clone' && recipe?.kind === 'git_clone'
        && placement.gitAccount === undefined && recipe.gitAccount !== undefined) {
        return { ...placement, gitAccount: recipe.gitAccount };
    }
    return placement;
}
