import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import type { AccountEncryptionMode } from '../features/payload/capabilities/encryptionCapabilities.js';
import type { SessionEncryptionMode } from './storagePolicyDecisions.js';

export const ClientEncryptionRequirementSchema = lazyZodSchema(() => z._default(z.catch(z
  .enum(['follow_account', 'require_e2ee']), 'follow_account'), 'follow_account'));

export type ClientEncryptionRequirement = z.infer<typeof ClientEncryptionRequirementSchema>;

export function combineClientEncryptionRequirements(
  ...requirements: readonly ClientEncryptionRequirement[]
): ClientEncryptionRequirement {
  return requirements.includes('require_e2ee') ? 'require_e2ee' : 'follow_account';
}

export function isAccountEncryptionModeAllowedByClientRequirement(
  requirement: ClientEncryptionRequirement,
  mode: AccountEncryptionMode,
): boolean {
  return requirement !== 'require_e2ee' || mode === 'e2ee';
}

export function isSessionEncryptionModeAllowedByClientRequirement(
  requirement: ClientEncryptionRequirement,
  mode: SessionEncryptionMode,
): boolean {
  return requirement !== 'require_e2ee' || mode === 'e2ee';
}
