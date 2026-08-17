import {
  isAccountStoredContentClientUpgradeRequiredError,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';

import { isVoiceHistoryOperationSupersededError } from './voiceHistoryConsumer';

export { isVoiceHistoryOperationSupersededError } from './voiceHistoryConsumer';

export type VoiceHistoryInitialLoadFailureState =
  | 'error'
  | 'superseded'
  | 'upgrade_required';

export function resolveVoiceHistoryInitialLoadFailureState(
  error: unknown,
): VoiceHistoryInitialLoadFailureState {
  if (isVoiceHistoryOperationSupersededError(error)) return 'superseded';
  if (isAccountStoredContentClientUpgradeRequiredError(error)) {
    return 'upgrade_required';
  }
  return 'error';
}
