import {
  serializeSessionModelSelectionV1,
  type BackendTargetRefV2,
  type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import {
  serializeNativeForkSourceV1,
  type NativeForkSource,
} from '@/session/shared/spawnSessionContract';
import { normalizeSessionControlPermissionModeForBackendTarget } from '@/session/backendTargets/permissionModes';
import { normalizeDaemonBackendTargetV2Input } from './backendTargetRouting';

export function buildHappySessionControlArgs(opts: Readonly<{
  permissionMode?: string;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelSelection?: SessionModelSelectionV1;
  resume?: string;
  nativeForkSource?: NativeForkSource;
  existingSessionId?: string;
  backendTarget?: BackendTargetRefV2;
}>): string[] {
  const args: string[] = [];

  const resume = typeof opts.resume === 'string' ? opts.resume.trim() : '';
  if (resume && opts.nativeForkSource) {
    throw new Error('Native fork source cannot be combined with provider resume');
  }
  if (resume) {
    args.push('--resume', resume);
  }
  if (opts.nativeForkSource) {
    args.push('--native-fork-source-v1', serializeNativeForkSourceV1(opts.nativeForkSource));
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

  if (opts.modelSelection) {
    args.push('--model-selection-v1', serializeSessionModelSelectionV1(opts.modelSelection));
  }

  return args;
}
