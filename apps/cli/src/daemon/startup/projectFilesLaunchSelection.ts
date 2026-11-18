import type { SessionProjectFilesV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

/** Carry an explicitly selected Git account from the retained recipe into a placed clone. */
export function resolveProjectFilesForManagedLaunch(input: Readonly<{
    placement?: SessionProjectFilesV1;
    recipe?: SessionProjectFilesV1;
}>): SessionProjectFilesV1 | undefined {
    const placement = input.placement;
    const recipe = input.recipe;
    if (!placement) return recipe;
    if (placement.kind === 'git_clone' && recipe?.kind === 'git_clone'
        && placement.gitAccount === undefined && recipe.gitAccount !== undefined) {
        return { ...placement, gitAccount: recipe.gitAccount };
    }
    return placement;
}
