import { SESSION_MANAGED_TARGET_BUSY_CODE, SPAWN_SESSION_ERROR_DETAIL_KINDS, SessionCreationTerminalSpawnErrorDetailSchema } from '@happier-dev/protocol/spawnSession';
import type { SessionCreationTerminalSpawnErrorDetail } from '@happier-dev/protocol';

import { isSessionCreationCorrespondenceConflictError } from './sessionCreationCorrespondenceConflictError';
import {
  SessionInitialAccessServerError,
  SessionInitialAccessUpdateRequiredError,
  SessionTeamCredentialBindingRejectedError,
} from './sessionCreationInitialAccess';
import { isSessionCreationPlacementError } from './sessionCreationPlacementError';
import { SessionCreationInitialTriggerError } from './sessionCreationInitialTriggerError';
import { AccountEncryptionCurrentnessUnavailableError } from '../client/accountEncryptionCurrentness';
import { classifyServerEndpointError } from '../client/classifyServerEndpointError';
import { HttpStatusError } from '../client/httpStatusError';

/**
 * The exact no-effect refusal a Session create-or-load failure carries to a
 * daemon spawn waiter, or null when the failure is not one of them. One
 * classification for every creator of a daemon-launched Session: the runner
 * that creates it from its creation tag and the daemon that commits it before
 * launch-scoped material is opened.
 */
export function readSessionCreationTerminalSpawnErrorDetail(
  error: unknown,
): SessionCreationTerminalSpawnErrorDetail | null {
  if (error instanceof AccountEncryptionCurrentnessUnavailableError) {
    const failure = classifyServerEndpointError(error);
    return {
      kind: 'session_creation_currentness_unavailable', code: 'currentness_unavailable',
      reason: failure.kind === 'timeout' || failure.kind === 'network' ? failure.kind
        : failure.statusCode !== undefined ? 'http_error' : 'invalid_response',
      retryable: failure.retryable,
      ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
    };
  }
  if (isSessionCreationPlacementError(error)) {
    return { kind: 'session_creation_organization_invalid', code: 'organization_invalid' };
  }
  if (isSessionCreationCorrespondenceConflictError(error)) {
    return { kind: 'session_creation_correspondence_conflict', code: 'creation_conflict' };
  }
  if (error instanceof HttpStatusError && 'code' in error && error.code === SESSION_MANAGED_TARGET_BUSY_CODE) {
    return { kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_MANAGED_TARGET_BUSY, code: error.code };
  }
  if (error instanceof SessionTeamCredentialBindingRejectedError) {
    return { kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_TEAM_CREDENTIAL_REFUSED,
      code: error.code, reason: error.reason };
  }
  if (error instanceof SessionInitialAccessServerError) {
    return { kind: 'session_creation_access_refused', code: error.code };
  }
  if (error instanceof SessionCreationInitialTriggerError) {
    return { kind: 'session_creation_initial_trigger_refused', code: error.code };
  }
  if (error instanceof SessionInitialAccessUpdateRequiredError) {
    return SessionCreationTerminalSpawnErrorDetailSchema.safeParse(error.details).data ?? null;
  }
  return null;
}
