import { describe, expect, it } from 'vitest';

import {
  isSessionEncryptionModeAllowedByStoragePolicy,
  isStoredContentKindAllowedForSessionByStoragePolicy,
  resolveEffectiveDefaultAccountEncryptionMode,
  resolveStoredContentKindForSessionEncryptionMode,
} from './storagePolicyDecisions.js';

describe('storagePolicyDecisions', () => {
  it('required_e2ee allows only e2ee sessions with encrypted content', () => {
    expect(isSessionEncryptionModeAllowedByStoragePolicy('required_e2ee', 'e2ee')).toBe(true);
    expect(isSessionEncryptionModeAllowedByStoragePolicy('required_e2ee', 'plain')).toBe(false);

    expect(isStoredContentKindAllowedForSessionByStoragePolicy('required_e2ee', 'e2ee', 'encrypted')).toBe(true);
    expect(isStoredContentKindAllowedForSessionByStoragePolicy('required_e2ee', 'e2ee', 'plain')).toBe(false);
    expect(isStoredContentKindAllowedForSessionByStoragePolicy('required_e2ee', 'plain', 'plain')).toBe(false);
  });

  it('plaintext_only allows only plain sessions with plain content', () => {
    expect(isSessionEncryptionModeAllowedByStoragePolicy('plaintext_only', 'plain')).toBe(true);
    expect(isSessionEncryptionModeAllowedByStoragePolicy('plaintext_only', 'e2ee')).toBe(false);

    expect(isStoredContentKindAllowedForSessionByStoragePolicy('plaintext_only', 'plain', 'plain')).toBe(true);
    expect(isStoredContentKindAllowedForSessionByStoragePolicy('plaintext_only', 'plain', 'encrypted')).toBe(false);
    expect(isStoredContentKindAllowedForSessionByStoragePolicy('plaintext_only', 'e2ee', 'encrypted')).toBe(false);
  });

  it('optional allows both session modes but requires mode and content kind to match', () => {
    expect(isSessionEncryptionModeAllowedByStoragePolicy('optional', 'e2ee')).toBe(true);
    expect(isSessionEncryptionModeAllowedByStoragePolicy('optional', 'plain')).toBe(true);

    expect(isStoredContentKindAllowedForSessionByStoragePolicy('optional', 'e2ee', 'encrypted')).toBe(true);
    expect(isStoredContentKindAllowedForSessionByStoragePolicy('optional', 'e2ee', 'plain')).toBe(false);
    expect(isStoredContentKindAllowedForSessionByStoragePolicy('optional', 'plain', 'plain')).toBe(true);
    expect(isStoredContentKindAllowedForSessionByStoragePolicy('optional', 'plain', 'encrypted')).toBe(false);
  });

  it('maps session encryption modes to stored content kinds', () => {
    expect(resolveStoredContentKindForSessionEncryptionMode('e2ee')).toBe('encrypted');
    expect(resolveStoredContentKindForSessionEncryptionMode('plain')).toBe('plain');
  });

  it('resolves an effective default account mode for each storage policy', () => {
    expect(resolveEffectiveDefaultAccountEncryptionMode('required_e2ee', 'plain')).toBe('e2ee');
    expect(resolveEffectiveDefaultAccountEncryptionMode('plaintext_only', 'e2ee')).toBe('plain');
    expect(resolveEffectiveDefaultAccountEncryptionMode('optional', 'plain')).toBe('plain');
    expect(resolveEffectiveDefaultAccountEncryptionMode('optional', 'e2ee')).toBe('e2ee');
  });
});
