import {
  evaluateSessionHandoffWorkspaceTransferSourcePathSafety,
  type SessionHandoffWorkspaceTransferPathSafetyReasonCode,
} from '@happier-dev/protocol';
import type { SessionHandoffWorkspaceTransferInput } from './sessionHandoffWorkspaceTransferInput';

export type SessionHandoffWorkspaceTransferSourcePathValidationResult = Readonly<
  | { ok: true }
  | {
      ok: false;
      errorCode: 'unsafe_workspace_transfer_path';
      error: string;
      reasonCode: SessionHandoffWorkspaceTransferPathSafetyReasonCode;
    }
>;

export function validateSessionHandoffWorkspaceTransferSourcePath(params: Readonly<{
  metadata: Record<string, unknown>;
  fallbackSourceHomeDir?: string;
  workspaceTransfer?: SessionHandoffWorkspaceTransferInput;
}>): SessionHandoffWorkspaceTransferSourcePathValidationResult {
  if (!params.workspaceTransfer?.enabled) {
    return { ok: true };
  }

  const workspaceTransferSafety = evaluateSessionHandoffWorkspaceTransferSourcePathSafety({
    sourcePath: params.metadata.path,
    sourceHomeDir: params.metadata.homeDir,
    fallbackSourceHomeDir: params.fallbackSourceHomeDir,
  });
  if (workspaceTransferSafety.allowed) {
    return { ok: true };
  }

  return {
    ok: false,
    errorCode: 'unsafe_workspace_transfer_path',
    error: 'Workspace transfer is unavailable for this source path',
    reasonCode: workspaceTransferSafety.reasonCode,
  };
}
