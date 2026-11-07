import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { readCodexNativeAuthCredentials } from '../cli/auth/readCodexEnvironmentAuthState';
import { buildNativeProviderAccountUsageSourceProfileId } from '@/daemon/connectedServices/accountUsage/nativeSourceIdentity';
import type { ConnectedServiceQuotaFetcher } from '@/daemon/connectedServices/quotas/types';

export function createCodexNativeQuotaCredentialReader(env: NodeJS.ProcessEnv): NonNullable<ConnectedServiceQuotaFetcher['readNativeCredentialForUsage']> {
  return async ({ snapshot, now, signal }) => {
    if (snapshot.providerId !== 'codex' || snapshot.recordKey.subjectKind !== 'account') return null;
    const native = await readCodexNativeAuthCredentials({ env, signal });
    if (snapshot.recordKey.accountSubjectId !== native.accountId) return null;
    const profileId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'providerSubject', providerId: 'codex', material: native.accountId });
    return { providerId: 'codex', record: buildConnectedServiceCredentialRecord({
      now, serviceId: 'openai-codex', profileId, kind: 'oauth', expiresAt: native.expiresAt,
      oauth: { accessToken: native.accessToken, refreshToken: native.refreshToken, idToken: null, tokenType: 'Bearer', scope: null,
        providerAccountId: native.accountId, providerEmail: null },
    }) };
  };
}
