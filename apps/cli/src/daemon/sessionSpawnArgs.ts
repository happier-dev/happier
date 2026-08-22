import {
  serializeSessionCreationCorrespondenceV1,
  serializeSessionModelSelectionV1,
  SessionCreationTagV1Schema,
  type BackendTargetRefV2,
  type SessionCreationCorrespondenceV1,
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
  /** Opaque host-derived identity carried only from daemon to its runner. */
  sessionCreationTag?: string;
  /** Immutable recipe used to reject a same-key create with different meaning. */
  sessionCreationCorrespondence?: SessionCreationCorrespondenceV1;
  /** Mutable presentation state that must reach only the fresh create envelope. */
  initialTitle?: string;
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

  if (opts.sessionCreationTag !== undefined) {
    const sessionCreationTag = SessionCreationTagV1Schema.parse(opts.sessionCreationTag);
    args.push('--session-creation-tag-v1', sessionCreationTag);
  }
  if (opts.sessionCreationCorrespondence !== undefined) {
    const correspondence = opts.sessionCreationCorrespondence;
    const sessionCreationTag = SessionCreationTagV1Schema.parse(opts.sessionCreationTag);
    if (correspondence.sessionCreationTag !== sessionCreationTag) {
      throw new Error('Session creation correspondence tag does not match the admitted tag');
    }
    args.push(
      '--session-creation-correspondence-v1',
      serializeSessionCreationCorrespondenceV1(correspondence),
    );
  }
  const initialTitle = typeof opts.initialTitle === 'string' ? opts.initialTitle.trim() : '';
  if (initialTitle) {
    args.push('--session-initial-title-v1', initialTitle);
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
