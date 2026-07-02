import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import { normalizeSessionControlPermissionModeForBackendTarget } from '@/backends/catalog';
import { normalizeDaemonBackendTargetV2Input } from './backendTargetRouting';

export function buildHappySessionControlArgs(opts: Readonly<{
  permissionMode?: string;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  resume?: string;
  existingSessionId?: string;
  backendTarget?: BackendTargetRefV2;
}>): string[] {
  const args: string[] = [];

  const resume = typeof opts.resume === 'string' ? opts.resume.trim() : '';
  if (resume) {
    args.push('--resume', resume);
  }

  const existingSessionId = typeof opts.existingSessionId === 'string' ? opts.existingSessionId.trim() : '';
  if (existingSessionId) {
    args.push('--existing-session', existingSessionId);
  }

  const backendTarget = normalizeDaemonBackendTargetV2Input(opts.backendTarget);
  const configuredAcpBackendId = backendTarget?.sourceKind === 'configured'
    ? (backendTarget.configuredBackendId ?? backendTarget.backendId).trim()
    : '';
  if (configuredAcpBackendId) {
    args.push('--backend', configuredAcpBackendId);
  }

  const permissionMode = typeof opts.permissionMode === 'string' ? opts.permissionMode.trim() : '';
  if (permissionMode) {
    const normalizedPermissionMode = normalizeSessionControlPermissionModeForBackendTarget({
      backendTarget: backendTarget ?? undefined,
      permissionMode,
    });
    args.push('--permission-mode', normalizedPermissionMode);
    if (typeof opts.permissionModeUpdatedAt === 'number') {
      args.push('--permission-mode-updated-at', `${opts.permissionModeUpdatedAt}`);
    }
  }

  const agentModeId = typeof opts.agentModeId === 'string' ? opts.agentModeId.trim() : '';
  if (agentModeId) {
    args.push('--agent-mode', agentModeId);
    if (typeof opts.agentModeUpdatedAt === 'number') {
      args.push('--agent-mode-updated-at', `${opts.agentModeUpdatedAt}`);
    }
  }

  const modelId = typeof opts.modelId === 'string' ? opts.modelId.trim() : '';
  if (modelId && typeof opts.modelUpdatedAt === 'number') {
    args.push('--model', modelId, '--model-updated-at', `${opts.modelUpdatedAt}`);
  }

  return args;
}
