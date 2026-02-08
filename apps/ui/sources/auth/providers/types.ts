import type { AuthCredentials } from '@/auth/tokenStorage';
import type { AuthProviderId } from '@happier-dev/protocol';

export type AuthProvider = Readonly<{
    id: AuthProviderId;
    displayName?: string;
    badgeIconName?: string;
    supportsProfileBadge?: boolean;
    connectButtonColor?: string;
    getExternalSignupUrl: (params: { publicKey: string }) => Promise<string>;
    getConnectUrl: (credentials: AuthCredentials) => Promise<string>;
    finalizeConnect: (credentials: AuthCredentials, params: { pending: string; username: string }) => Promise<void>;
    cancelConnectPending: (credentials: AuthCredentials, pending: string) => Promise<void>;
    disconnect: (credentials: AuthCredentials) => Promise<void>;
}>;
