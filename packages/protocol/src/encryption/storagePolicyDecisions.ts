import type {
  AccountEncryptionMode,
  EncryptionStoragePolicy,
} from '../features/payload/capabilities/encryptionCapabilities.js';

export type SessionEncryptionMode = AccountEncryptionMode;
export type SessionStoredContentKind = 'encrypted' | 'plain';

export function resolveStoredContentKindForSessionEncryptionMode(
  mode: SessionEncryptionMode,
): SessionStoredContentKind {
  return mode === 'plain' ? 'plain' : 'encrypted';
}

export function resolveEffectiveDefaultAccountEncryptionMode(
  storagePolicy: EncryptionStoragePolicy,
  configuredDefaultMode: AccountEncryptionMode,
): AccountEncryptionMode {
  if (storagePolicy === 'required_e2ee') return 'e2ee';
  if (storagePolicy === 'plaintext_only') return 'plain';
  return configuredDefaultMode;
}

export function isSessionEncryptionModeAllowedByStoragePolicy(
  storagePolicy: EncryptionStoragePolicy,
  mode: SessionEncryptionMode,
): boolean {
  if (storagePolicy === 'required_e2ee') return mode === 'e2ee';
  if (storagePolicy === 'plaintext_only') return mode === 'plain';
  return true;
}

export function isStoredContentKindAllowedForSessionByStoragePolicy(
  storagePolicy: EncryptionStoragePolicy,
  sessionEncryptionMode: SessionEncryptionMode,
  contentKind: SessionStoredContentKind,
): boolean {
  if (storagePolicy === 'required_e2ee') {
    return sessionEncryptionMode === 'e2ee' && contentKind === 'encrypted';
  }
  if (storagePolicy === 'plaintext_only') {
    return sessionEncryptionMode === 'plain' && contentKind === 'plain';
  }

  const expected = resolveStoredContentKindForSessionEncryptionMode(sessionEncryptionMode);
  return contentKind === expected;
}
