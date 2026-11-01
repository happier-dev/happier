import { AccountKeyProvisioningUnavailableError, assertAccountKeyProvisioningAllowed } from '@happier-dev/protocol';
import { isTokenOnlyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { getUserProfile } from '@/sync/api/social/apiFriends';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { parseToken } from '@/utils/auth/parseToken';

/** Reads current Account authority at the same relay before releasing credential material. */
export async function assertCurrentAccountKeyForProvisioning(
  credentials: AuthCredentials,
  options: Readonly<{ endpointUrl?: string }> = {},
): Promise<void> {
  const { mode } = await fetchAccountEncryptionMode(credentials, { retry: 'none', ...options });
  if (mode === 'plain') return;
  const accountId = parseToken(credentials.token);
  const account = await getUserProfile(credentials, accountId, { retry: 'none', ...options });
  if (!account || account.id !== accountId) throw new AccountKeyProvisioningUnavailableError();
  assertAccountKeyProvisioningAllowed({
    mode, account,
    material: isTokenOnlyAuthCredentials(credentials) ? null : resolveAccountScopedCryptoMaterialFromCredentials(credentials),
  });
}
