import { describe, expect, it } from 'vitest';

import { AccountStoredContentClientUpgradeRequiredError } from '@/sync/api/capabilities/accountStoredContentCompatibility';

import {
  resolveVoiceHistoryInitialLoadFailureState,
} from './voiceHistoryInitialLoadState';

describe('resolveVoiceHistoryInitialLoadFailureState', () => {
  it('preserves the existing non-retryable stored-content compatibility kind instead of treating it as a retryable generic failure', () => {
    expect(resolveVoiceHistoryInitialLoadFailureState(
      new AccountStoredContentClientUpgradeRequiredError('server-too-old'),
    )).toBe('upgrade_required');
  });

  it('does not infer compatibility from an arbitrary error message', () => {
    expect(resolveVoiceHistoryInitialLoadFailureState(
      new Error('client-upgrade-required'),
    )).toBe('error');
  });
});
