import type { SessionProviderBindingMetadataV1 } from './bindingMetadataV1.js';

export type SessionProviderBindingChangeV1 =
  | 'unchanged'
  | 'benign_change'
  | 'security_change'
  | 'connection_change';

export function compareSessionProviderBindingV1(
  current: SessionProviderBindingMetadataV1,
  next: SessionProviderBindingMetadataV1,
): SessionProviderBindingChangeV1 {
  if (current.connectionId !== next.connectionId) return 'connection_change';
  if (current.bindingSecurityFingerprint !== next.bindingSecurityFingerprint) return 'security_change';
  return JSON.stringify(current) === JSON.stringify(next) ? 'unchanged' : 'benign_change';
}
