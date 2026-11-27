import { describe, expect, it, vi } from 'vitest';

import * as pending from '@/api/session/pendingQueueV2Transport';

import {
  observeTransitionTargetSpawn,
  resolveFailedFirstLaunchAccountSwitch,
  runFirstTransitionLaunch,
} from './failedFirstLaunch';

describe('first transition launch account recovery', () => {
  it.each([
    ['the same input refused before provider open', undefined, 'original-input', true, 'retry_original_transition'],
    ['the same input with a normalized empty nonce', '', 'original-input', true, 'retry_original_transition'],
    ['the same input without a definitive refusal', undefined, 'original-input', false, undefined],
    ['a different input refused before provider open', undefined, 'another-input', true, undefined],
  ] as const)('handles %s', async (description, retryNonce, requestId, refused, expected) => {
    const launch = {
      sessionId: description, agentId: 'codex', localId: 'original-input', metadataVersion: 4, pendingVersion: 2,
    };
    const current = { ...launch, token: 'test-token', active: false };
    const eligibility = vi.spyOn(pending, 'readPendingQueueV2ActivationEligibilityFromServer').mockResolvedValue('eligible');
    try {
      await runFirstTransitionLaunch(launch, async nonce => {
        const scope = observeTransitionTargetSpawn(launch.sessionId, nonce);
        scope?.credentialRefused();
        scope?.finish();
      });
      expect(await resolveFailedFirstLaunchAccountSwitch(current)).toBe('retry_original_transition');

      const retry = observeTransitionTargetSpawn(launch.sessionId, retryNonce, requestId);
      expect(await resolveFailedFirstLaunchAccountSwitch(current)).toBeUndefined();
      if (refused) retry?.credentialRefused();
      retry?.finish();

      expect(await resolveFailedFirstLaunchAccountSwitch(current)).toBe(expected);
    } finally {
      observeTransitionTargetSpawn(launch.sessionId, 'independent-launch');
      eligibility.mockRestore();
    }
  });
});
