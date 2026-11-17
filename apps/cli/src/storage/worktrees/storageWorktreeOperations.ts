import { lstat } from 'node:fs/promises';
import type { BackendRuntimeContext } from '@happier-dev/plugin-sdk/scm/backend';
import type { ScmBackendRegistry } from '@/scm/registry';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN, type ScmWorktreeRemoveResponse, type ScmWorktreesEnrichmentResponse } from '@happier-dev/protocol/scm';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { prepareProjectCheckoutRemoval, type ProjectCheckoutRemoval } from '@/workspaces/projectSetup/projectCheckoutRemoval';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';

/** Private admitted requester and parent operation; never persisted in Trash owner data. */
export type StorageWorktreeRemovalContext = Readonly<{
    ingress: RpcHandlerContext;
    context: ActionExecutorContext;
    operation: ProjectSetupOperationContext;
    skipCleanup?: boolean;
}>;

type Target = Readonly<{ repositoryRoot: string; worktreePath: string; retentionKind?: 'main' | 'common' | 'orphan';
    retainedSourcePath?: string; beforeEffect?: () => Promise<void>; removalContext?: StorageWorktreeRemovalContext }>;
type MoveTarget = Target & Readonly<{ targetPath: string; entryId: string }>;

/** Storage delegates to the same selected contribution as interactive source-control operations. */
export function createStorageWorktreeOperations(deps: Readonly<{ happyHomeDir: string; registry?: ScmBackendRegistry;
    resolveProjectRuntime?: (ingress: RpcHandlerContext) => Promise<ProjectFiniteActionRuntime | null> }>) {
    async function run(target: Target, operation: 'retire' | 'reinstate' | 'remove', move?: MoveTarget): Promise<ProjectCheckoutRemoval | undefined> {
        let cwd = target.repositoryRoot;
        if (operation === 'remove' && target.retentionKind && target.beforeEffect) {
            try { await lstat(target.worktreePath); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                await target.beforeEffect();
                return;
            }
        }
        if (target.retentionKind === 'main' || target.retentionKind === 'common') {
            cwd = target.worktreePath;
            try { await lstat(cwd); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && move) cwd = move.targetPath; else throw error; }
        }
        let guardFailed = false;
        let guardError: unknown;
        let preparation: Promise<ProjectCheckoutRemoval> | undefined;
        const liveRemoval = operation !== 'reinstate' && (!target.retainedSourcePath
            || canonicalAbsolutePathsEqual(target.retainedSourcePath, target.worktreePath));
        const beforeFilesystemMutation: NonNullable<BackendRuntimeContext['beforeFilesystemMutation']> = async missingWorktree => {
            try {
                await target.beforeEffect?.();
                if (liveRemoval && deps.resolveProjectRuntime) {
                    const removal = target.removalContext;
                    if (!removal) throw Object.assign(new Error('project_setup_operation_unavailable'), { code: 'project_setup_operation_unavailable' });
                    preparation ??= (async () => {
                        const runtime = await deps.resolveProjectRuntime!(removal.ingress);
                        if (!runtime) throw Object.assign(new Error('project_setup_operation_unavailable'), { code: 'project_setup_operation_unavailable' });
                        return prepareProjectCheckoutRemoval({ runtime, ...removal, worktreePath: target.worktreePath,
                            ...(missingWorktree ? { missingWorktree } : {}) });
                    })();
                    await preparation;
                }
            }
            catch (error) { guardFailed = true; guardError = error; throw error; }
        };
        const result = await runWithScmBackendRegistryLease(deps.registry, registry => runScmRoute<
            { cwd: string }, ScmWorktreeRemoveResponse
        >({
            request: { cwd }, workingDirectory: cwd, registry,
            onNonRepository: () => ({ success: false, errorCode: 'NOT_REPOSITORY' }),
            runWithBackend: async ({ context, selection }) => {
                if (operation === 'remove') {
                    if (!selection.backend.worktreeRemove) return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
                    return selection.backend.worktreeRemove({ context: { ...context, beforeFilesystemMutation,
                        ...(target.retainedSourcePath ? { retainedSourcePath: target.retainedSourcePath } : {}) }, request: { cwd: target.repositoryRoot,
                        worktreePath: target.worktreePath, confirmed: true, authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } });
                }
                const handler = operation === 'retire' ? selection.backend.worktreeRetire : selection.backend.worktreeReinstate;
                if (!handler || !move) return { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
                return handler({ context: { ...context, beforeFilesystemMutation }, request: { cwd: target.repositoryRoot, worktreePath: target.worktreePath,
                    targetPath: move.targetPath, entryId: move.entryId } });
            },
        }), { happyHomeDir: deps.happyHomeDir });
        if (guardFailed) throw guardError;
        if (!result.success) throw Object.assign(new Error(result.error ?? 'Worktree operation failed'), { errorCode: result.errorCode });
        return preparation ? await preparation : undefined;
    }
    return {
        inspect: (repositoryRoot: string, worktreePaths: string[]) => runWithScmBackendRegistryLease(deps.registry, registry =>
            runScmRoute<{ cwd: string }, ScmWorktreesEnrichmentResponse>({ request: { cwd: repositoryRoot }, workingDirectory: repositoryRoot, registry,
                onNonRepository: () => ({ success: false }), runWithBackend: ({ context, selection }) =>
                    selection.backend.worktreesEnrichment?.({ context, request: { cwd: repositoryRoot, worktreePaths } })
                    ?? Promise.resolve({ success: false }) }), { happyHomeDir: deps.happyHomeDir }),
        retire: (target: MoveTarget) => run(target, 'retire', target),
        reinstate: (target: MoveTarget) => run(target, 'reinstate', target),
        remove: (target: Target) => run(target, 'remove'),
    };
}
