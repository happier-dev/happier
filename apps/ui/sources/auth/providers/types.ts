import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { AuthProviderId } from '@happier-dev/protocol';

export type RestoreRedirectReason = 'provider_already_linked';

export type RestoreRedirectNotice = Readonly<{
    title: string;
    body: string;
}>;

export type AuthProvider = Readonly<{
    id: AuthProviderId;
    displayName?: string;
    badgeIconName?: string;
    supportsProfileBadge?: boolean;
    connectButtonColor?: string;
    getRestoreRedirectNotice?: (params: { reason: RestoreRedirectReason }) => RestoreRedirectNotice | null;
    getExternalSignupUrl: (params: { publicKey: string }) => Promise<string>;
    getConnectUrl: (credentials: AuthCredentials) => Promise<string>;
    finalizeConnect: (credentials: AuthCredentials, params: { pending: string; username: string }) => Promise<void>;
    cancelConnectPending: (credentials: AuthCredentials, pending: string) => Promise<void>;
    disconnect: (credentials: AuthCredentials) => Promise<void>;
}>;
