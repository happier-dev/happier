import { storage } from '@/sync/domains/state/storage';

import { isReadAloudAvailable } from './localVoiceSettings';

/** A boolean selector, so only a change in availability (not any voice preference) rerenders the reader. */
export function useReadAloudAvailable(): boolean {
  return storage((state) => isReadAloudAvailable(state.settings));
}
