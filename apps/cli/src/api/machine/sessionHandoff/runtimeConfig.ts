import { configuration } from '@/configuration';

export type SessionHandoffRuntimeConfig = Readonly<{
  activeServerDir: string;
  workspaceReplicationBlobPackTargetBytes: number;
  workspaceReplicationBlobPackMaxBlobs: number;
  workspaceReplicationBlobPackMaxSingleBlobBytes: number;
  filesTransferSessionTtlMs?: number;
}>;

export function readSessionHandoffRuntimeConfig(): SessionHandoffRuntimeConfig {
  return {
    activeServerDir: configuration.activeServerDir,
    workspaceReplicationBlobPackTargetBytes: configuration.workspaceReplicationBlobPackTargetBytes,
    workspaceReplicationBlobPackMaxBlobs: configuration.workspaceReplicationBlobPackMaxBlobs,
    workspaceReplicationBlobPackMaxSingleBlobBytes: configuration.workspaceReplicationBlobPackMaxSingleBlobBytes,
    ...(typeof configuration.filesTransferSessionTtlMs === 'number'
      ? { filesTransferSessionTtlMs: configuration.filesTransferSessionTtlMs }
      : {}),
  };
}

export function resolveSessionHandoffTransferTimeoutMs(
  runtimeConfig: SessionHandoffRuntimeConfig,
): number | undefined {
  const timeoutMs = runtimeConfig.filesTransferSessionTtlMs;
  return typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : undefined;
}
