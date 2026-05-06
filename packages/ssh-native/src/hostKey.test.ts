import { describe, expect, it } from 'vitest';

import { normalizeHostKeyFingerprintSha256 } from './hostKey';

describe('native SSH host-key fingerprint normalization', () => {
  it('normalizes SHA256 host-key fingerprints for prompts and comparisons', () => {
    expect(normalizeHostKeyFingerprintSha256('  sha256:AbC123=  ')).toBe('SHA256:AbC123');
  });

  it('rejects empty host-key fingerprints', () => {
    expect(normalizeHostKeyFingerprintSha256('SHA256:   ')).toBeNull();
  });
});
