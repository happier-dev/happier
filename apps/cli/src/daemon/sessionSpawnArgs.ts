import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { serializeSessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { MachinePoolSelectionOriginV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import type { BackendTargetRefV2, MachinePoolSelectionOriginV1, SessionCreationCorrespondenceV1, SessionModelSelectionV1 } from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import type { SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol/teams';
import {
  serializeNativeForkSourceV1,
  type NativeForkSource,
} from '@/session/shared/spawnSessionContract';
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
  /** Informational origin written only by the fresh Session creation owner. */
  placementOrigin?: MachinePoolSelectionOriginV1;
  /** Mutable presentation state that must reach only the fresh create envelope. */
  initialTitle?: string;
  initialAccessFilePath?: string;
  primaryTeamId?: string | null;
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
  existingSessionId?: string;
  backendTarget?: BackendTargetRefV2;
}>): string[] {
  const args: string[] = [];

  // The Agent minted this id; the runner receives the exact bytes.
  const resume = readNonBlankOpaqueIdentifier(opts.resume);
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
    const correspondence = SessionCreationCorrespondenceV1Schema.parse(opts.sessionCreationCorrespondence);
    const sessionCreationTag = SessionCreationTagV1Schema.parse(opts.sessionCreationTag);
    if (correspondence.sessionCreationTag !== sessionCreationTag) {
      throw new Error('Session creation correspondence tag does not match the admitted tag');
    }
    args.push(
      '--session-creation-correspondence-v1',
      JSON.stringify(correspondence),
    );
  }
  if (opts.placementOrigin !== undefined) {
    const placementOrigin = MachinePoolSelectionOriginV1Schema.parse(opts.placementOrigin);
    args.push('--session-placement-origin-v1', JSON.stringify(placementOrigin));
  }
  const initialTitle = typeof opts.initialTitle === 'string' ? opts.initialTitle.trim() : '';
  if (initialTitle) {
    args.push('--session-initial-title-v1', initialTitle);
  }
  const existingSessionId = typeof opts.existingSessionId === 'string' ? opts.existingSessionId.trim() : '';
  if (
    opts.initialAccessFilePath !== undefined
    || opts.primaryTeamId !== undefined
    || opts.teamCredentialBindings !== undefined
  ) {
    if (existingSessionId) throw new Error('Initial access and Team context require fresh Session creation');
    if (opts.initialAccessFilePath !== undefined) args.push('--session-initial-access-file-v1', opts.initialAccessFilePath);
    if (opts.primaryTeamId !== undefined) args.push('--session-primary-team-id-v1', JSON.stringify(opts.primaryTeamId));
    if (opts.teamCredentialBindings !== undefined) {
      args.push(
        '--session-team-credential-bindings-v1',
        JSON.stringify(SessionTeamCredentialBindingIntentsV1Schema.parse(opts.teamCredentialBindings)),
      );
    }
  }
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
    args.push('--permission-mode', permissionMode);
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
