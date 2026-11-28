import { z } from 'zod/mini';
import {
  serverAccountScopeKeySuffix,
  type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
  createPersistentUiState,
  UiStatePersistenceError,
  usePersistentUiStateValue,
} from './persistentUiState';

/**
 * Which rail arrivals (owner 11-28, rail C) this device has seen the person have something in, per exact
 * Account and Home: once a destination joins the rail by default it stays, even if its last item goes. A
 * device-local observation like the Machines rail's seen record: not a preference, never synchronized.
 */
export const appRailArrivalsState = createPersistentUiState(
  'app-rail-arrivals-v1',
  (value) => z.literal(true).parse(value),
);

function arrivalKey(scope: ServerAccountScope, id: string): string {
  return `${serverAccountScopeKeySuffix(scope)}:${id}`;
}

export function useAppRailArrival(
  scope: ServerAccountScope | null,
  id: string,
): boolean {
  return (
    usePersistentUiStateValue(
      appRailArrivalsState,
      scope ? arrivalKey(scope, id) : null,
    ) === true
  );
}

/** Records the arrival; `false` when it was already recorded or cannot be persisted (nothing to announce). */
export function recordAppRailArrival(
  scope: ServerAccountScope,
  id: string,
): boolean {
  const key = arrivalKey(scope, id);
  if (appRailArrivalsState.read(key) === true) return false;
  try {
    appRailArrivalsState.set(key, true);
    return true;
  } catch (error) {
    if (!(error instanceof UiStatePersistenceError)) throw error;
    console.warn('[rail] Arrival could not be persisted.');
    return false;
  }
}
