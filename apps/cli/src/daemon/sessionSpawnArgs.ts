import type { BackendTargetRefV2Input } from '@happier-dev/protocol';
import { resolveConcreteBackendTargetRefs } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { normalizeSessionControlPermissionModeForBackendTarget } from '@/backends/catalog';

export function buildHappySessionControlArgs(opts: Readonly<{
  permissionMode?: string;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  resume?: string;
  existingSessionId?: string;
  backendTarget?: BackendTargetRefV2Input;
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

  const resolvedBackendTarget = resolveConcreteBackendTargetRefs(opts.backendTarget);
  const configuredAcpBackendId = resolvedBackendTarget?.backendTarget.kind === 'configuredAcpBackend'
    ? resolvedBackendTarget.backendTarget.backendId.trim()
    : '';
  if (configuredAcpBackendId) {
    args.push('--backend', configuredAcpBackendId);
  }

  const permissionMode = typeof opts.permissionMode === 'string' ? opts.permissionMode.trim() : '';
  if (permissionMode) {
    args.push('--permission-mode', normalizeSessionControlPermissionModeForBackendTarget({
      backendTarget: resolvedBackendTarget?.backendTarget ?? undefined,
      permissionMode,
    }));
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
