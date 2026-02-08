import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerGitCommitHandlers } from './git/registerCommitHandlers';
import { registerGitDiffHandlers } from './git/registerDiffHandlers';
import { registerGitPatchHandlers } from './git/registerPatchHandlers';
import { registerGitRemoteHandlers } from './git/registerRemoteHandlers';
import { registerGitStatusHandlers } from './git/registerStatusHandlers';

export { buildGitPullArgs, buildGitPushArgs, mapGitErrorCode, normalizeGitRemoteRequest } from './git/remote';
export { writeGitStdin } from './git/runtime';

export function registerGitHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    registerGitStatusHandlers(rpcHandlerManager, workingDirectory);
    registerGitDiffHandlers(rpcHandlerManager, workingDirectory);
    registerGitPatchHandlers(rpcHandlerManager, workingDirectory);
    registerGitCommitHandlers(rpcHandlerManager, workingDirectory);
    registerGitRemoteHandlers(rpcHandlerManager, workingDirectory);
}
