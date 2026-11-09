import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchPushTokensRemoteAlertProjection } from '@/sync/api/session/apiPush';
import { deriveAccountRemoteAlertPolicyV1, type AccountRemoteAlertPolicyV1 } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import type { AccountSettingsBaselineRequest } from '../accountSettingsBaseline';

/** Negotiates disclosure only when the Settings owner has admitted an actual write. */
export function createRemoteAlertPolicyWriteback(params: Readonly<{
    credentials: AuthCredentials;
    request: AccountSettingsBaselineRequest;
}>) {
    let projection: ReturnType<typeof fetchPushTokensRemoteAlertProjection> | null = null;
    let policyPrepared = false;
    const read = () => projection ??= fetchPushTokensRemoteAlertProjection(params.credentials, params.request).catch(() => null);
    return {
        async prepare(before: Readonly<Record<string, unknown>> | null, after: Readonly<Record<string, unknown>>, writeSupported?: true): Promise<Readonly<{
            remoteAlertPolicy?: AccountRemoteAlertPolicyV1 | null;
        }>> {
            const policy = deriveAccountRemoteAlertPolicyV1(after);
            // Enabled policies must follow every Settings revision; a disabling write
            // must also withdraw its previously enabled projection after negotiation.
            if (!policyPrepared && projection === null && policy === null && deriveAccountRemoteAlertPolicyV1(before) === null) return {};
            if (writeSupported || await read()) {
                policyPrepared = true;
                return { remoteAlertPolicy: policy };
            }
            return {};
        },
    };
}
