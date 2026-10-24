import {
  CodeIntelligenceCommitAnalyzeRequestV1Schema,
  CodeIntelligenceRepositoryRegisterRequestV1Schema,
  CodeIntelligenceSnapshotRequestV1Schema,
  type CodeIntelligenceCommitAnalyzeResponseV1,
  type CodeIntelligenceRepositoryRegisterResponseV1,
  type CodeIntelligenceSettingsV1,
  type CodeIntelligenceSnapshotResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { CodeIntelligenceWorkerHandle } from '@/daemon/codeIntelligence/codeIntelligenceWorker';
import {
  resolveFilesystemAccessPolicy,
  resolveFilesystemPolicyDefaultDirectory,
  type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { resolveMachineRpcWorkingDirectory } from './resolveMachineRpcWorkingDirectory';

function invalidRequest(error: string) {
  return { ok: false as const, errorCode: 'invalid_request' as const, error };
}

/**
 * Typed, read-mostly surface over the daemon's code-intelligence worker. Nothing here executes
 * commands or touches a checkout beyond read-only git inspection.
 */
export function registerMachineCodeIntelligenceRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  worker: CodeIntelligenceWorkerHandle;
  deps?: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    workingDirectory?: string;
    accessPolicy?: FilesystemAccessPolicy;
  }>;
}>): void {
  const { rpcHandlerManager, worker } = params;
  const env = params.deps?.env ?? process.env;
  const platform = params.deps?.platform ?? process.platform;
  // A client-supplied repository path is held to the same machine RPC filesystem policy as the
  // file browser and terminal, so registration cannot reach outside the configured roots.
  const accessPolicy = params.deps?.accessPolicy ?? resolveFilesystemAccessPolicy({ env, platform });
  const workingDirectory = params.deps?.workingDirectory
    ?? resolveFilesystemPolicyDefaultDirectory({
      defaultDirectory: resolveMachineRpcWorkingDirectory({ env, platform }),
      accessPolicy,
    });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SNAPSHOT_GET, async (raw: unknown): Promise<CodeIntelligenceSnapshotResponseV1> => {
    const parsed = CodeIntelligenceSnapshotRequestV1Schema.safeParse(raw ?? {});
    return parsed.success ? worker.getSnapshot(parsed.data) : invalidRequest('Invalid snapshot request');
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_REPOSITORY_REGISTER, async (raw: unknown): Promise<CodeIntelligenceRepositoryRegisterResponseV1> => {
    const parsed = CodeIntelligenceRepositoryRegisterRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidRequest('Invalid repository path');
    const authorization = authorizeFilesystemPath({
      targetPath: expandHomeDirPath(parsed.data.path.trim(), env, platform),
      defaultDirectory: workingDirectory,
      accessPolicy,
      platform,
    });
    if (!authorization.valid) {
      return { ok: false, errorCode: 'path_not_allowed', error: 'Path is outside the directories this machine allows' };
    }
    return await worker.registerRepository(authorization.resolvedPath);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_COMMIT_ANALYZE, async (raw: unknown): Promise<CodeIntelligenceCommitAnalyzeResponseV1> => {
    const parsed = CodeIntelligenceCommitAnalyzeRequestV1Schema.safeParse(raw);
    return parsed.success ? await worker.requestCommitAnalysis(parsed.data) : invalidRequest('Invalid commit reference');
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SETTINGS_GET, async (): Promise<CodeIntelligenceSettingsV1> => worker.getSettings());

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SETTINGS_SET, async (raw: unknown): Promise<CodeIntelligenceSettingsV1> => {
    // Settings are replaced as a whole; a missing payload must not silently reset them to defaults.
    if (!raw || typeof raw !== 'object' || !('settings' in raw)) throw new Error('Expected { settings }');
    return await worker.setSettings((raw as { settings: unknown }).settings);
  });
}
