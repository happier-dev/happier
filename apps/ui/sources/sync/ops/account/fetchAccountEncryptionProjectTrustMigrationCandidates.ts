import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchProjectTrustInventory } from '@/sync/api/account/apiProjectTrust';
import type { AccountEncryptionProjectTrustMigrationCandidate } from './buildAccountEncryptionProjectTrustDirective';

/** Full census at the captured Home: no cached grant or custodian Account substitutes for the requester. */
export async function fetchAccountEncryptionProjectTrustMigrationCandidates(params: Readonly<{
  credentials: AuthCredentials; mode: 'plain' | 'e2ee'; request(path: string, init?: RequestInit): Promise<Response>;
}>): Promise<readonly AccountEncryptionProjectTrustMigrationCandidate[]> {
  return fetchProjectTrustInventory(params);
}
