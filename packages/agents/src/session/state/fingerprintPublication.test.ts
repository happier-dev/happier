import { describe, expect, it } from 'vitest';

import {
  createFingerprintPublicationState,
  resolveFingerprintPublication,
  rollbackFingerprintPublication,
} from './policies/fingerprintPublication.js';

describe('fingerprintPublication', () => {
  it('skips unchanged fingerprints', () => {
    const state = createFingerprintPublicationState('fp-1');

    expect(resolveFingerprintPublication({ state, nextFingerprint: 'fp-1' })).toEqual({
      publish: false,
      state,
      reason: 'unchanged',
    });
  });

  it('marks changed fingerprints as publishable', () => {
    const state = createFingerprintPublicationState('fp-1');

    expect(resolveFingerprintPublication({ state, nextFingerprint: 'fp-2' })).toEqual({
      publish: true,
      state: {
        lastPublishedFingerprint: 'fp-2',
        rollbackFingerprint: 'fp-1',
      },
      reason: 'changed',
    });
  });

  it('rolls back publication state after a failed write', () => {
    const changed = resolveFingerprintPublication({
      state: createFingerprintPublicationState('fp-1'),
      nextFingerprint: 'fp-2',
    });

    expect(changed.publish).toBe(true);
    expect(rollbackFingerprintPublication(changed.state)).toEqual({
      lastPublishedFingerprint: 'fp-1',
      rollbackFingerprint: null,
    });
  });
});
