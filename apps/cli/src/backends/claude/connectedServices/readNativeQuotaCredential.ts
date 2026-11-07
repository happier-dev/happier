import { resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';
import { buildConnectedServiceCredentialRecord, readClaudeOauthCredentialOrganizationId, type ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';
import { buildNativeProviderAccountUsageSourceProfileId } from '@/daemon/connectedServices/accountUsage/nativeSourceIdentity';
import type { ClaudeSubscriptionProfileContextResult } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';
import type { ConnectedServiceQuotaFetcher } from '@/daemon/connectedServices/quotas/types';
import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';
import { readClaudeCodeNativeCredential } from './nativeAuth/claudeCodeCredentialFile';

export function createClaudeNativeQuotaCredentialReader(
  env: NodeJS.ProcessEnv,
  readProfile: (record: Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }>, now: number, signal: AbortSignal) => Promise<ClaudeSubscriptionProfileContextResult>,
): NonNullable<ConnectedServiceQuotaFetcher['readNativeCredentialForUsage']> {
  return async ({ snapshot, now, signal }) => {
    if (snapshot.providerId !== 'claude') return null;
    const claudeConfigDir = resolveConfiguredClaudeConfigDir({ env });
    const profileId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'localCredential', providerId: 'claude', material: claudeConfigDir });
    const provisional = snapshot.recordKey.subjectKind === 'unknown'
      && snapshot.recordKey.accountSubjectId === `legacy-connected-service:claude-subscription:${profileId}`;
    if (!provisional && snapshot.recordKey.subjectKind !== 'account') return null;
    const native = await readClaudeCodeNativeCredential({ claudeConfigDir, homeDir: resolveHomeDirFromEnvironment(env), signal });
    const oauth = native?.payload.claudeAiOauth;
    if (!oauth?.refreshToken || (oauth.expiresAt !== undefined && oauth.expiresAt <= now)) return null;
    const record = buildConnectedServiceCredentialRecord({
      now, serviceId: 'claude-subscription', profileId, kind: 'oauth', expiresAt: oauth.expiresAt ?? null,
      oauth: { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, idToken: null, tokenType: 'Bearer', scope: oauth.scopes.join(' '),
        providerAccountId: provisional ? null : snapshot.recordKey.accountSubjectId, providerEmail: null },
    });
    if (record.kind !== 'oauth') return null;
    // Root-config identity is not token proof. A stable record needs the same token's provider response.
    const profile = !provisional ? await readProfile(record, now, signal) : null;
    if (!provisional && (profile?.status !== 'accepted'
      || readClaudeOauthCredentialOrganizationId(profile.raw) !== snapshot.recordKey.quotaScopeId)) return null;
    return { providerId: 'claude', record: buildConnectedServiceCredentialRecord({
      now, serviceId: 'claude-subscription', profileId, kind: 'oauth', expiresAt: oauth.expiresAt ?? null,
      oauth: { accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, idToken: null, tokenType: 'Bearer', scope: oauth.scopes.join(' '),
        providerAccountId: profile?.status === 'accepted' ? profile.providerAccountId : null,
        providerEmail: profile?.status === 'accepted' ? profile.providerEmail : null,
        raw: profile?.status === 'accepted' ? profile.raw : null },
    }) };
  };
}
