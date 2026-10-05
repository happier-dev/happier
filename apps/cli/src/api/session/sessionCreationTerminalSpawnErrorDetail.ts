import {
  SessionCreationTerminalSpawnErrorDetailSchema,
  type SessionCreationTerminalSpawnErrorDetail,
} from '@happier-dev/protocol';

import { isSessionCreationCorrespondenceConflictError } from './sessionCreationCorrespondenceConflictError';
import {
  SessionInitialAccessServerError,
  SessionInitialAccessUpdateRequiredError,
} from './sessionCreationInitialAccess';
import { isSessionCreationPlacementError } from './sessionCreationPlacementError';
import { SessionCreationInitialTriggerError } from './sessionCreationInitialTriggerError';

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
  if (isSessionCreationPlacementError(error)) {
    return { kind: 'session_creation_organization_invalid', code: 'organization_invalid' };
  }
  if (isSessionCreationCorrespondenceConflictError(error)) {
    return { kind: 'session_creation_correspondence_conflict', code: 'creation_conflict' };
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
