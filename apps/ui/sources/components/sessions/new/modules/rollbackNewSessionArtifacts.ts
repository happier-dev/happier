import type { NewSessionCheckoutCreationDraft } from '@/sync/domains/state/newSessionCheckoutDraft';

export interface RollbackNewSessionArtifactsParams {
    machineId: string;
    selectedPath: string;
    actualPath: string;
    checkoutCreationDraft?: NewSessionCheckoutCreationDraft | null;
    serverId?: string | null;
    machineBash: (
        machineId: string,
        command: string | Readonly<{ argv: readonly string[] }>,
        cwd: string,
        options?: Readonly<{ serverId?: string | null }>,
    ) => Promise<{ success: boolean; stderr: string }>;
}

export async function rollbackNewSessionArtifacts(
    params: Readonly<RollbackNewSessionArtifactsParams>,
): Promise<void> {
    const requestOptions = { serverId: params.serverId };
    const errors: string[] = [];

    if (params.checkoutCreationDraft?.kind === 'git_worktree' && params.actualPath !== params.selectedPath) {
        const result = await params.machineBash(
            params.machineId,
            { argv: ['git', 'worktree', 'remove', '--force', '--', params.actualPath] },
            params.selectedPath,
            requestOptions,
        );
        if (!result.success) {
            errors.push(result.stderr || 'Failed to remove created worktree');
        }
    }

    if (errors.length > 0) {
        throw new Error(errors.join('; '));
    }
}
