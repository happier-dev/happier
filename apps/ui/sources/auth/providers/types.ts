import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { AuthProviderId } from '@happier-dev/protocol/auth/providers';

export type ExternalAuthStartInput =
    | { mode: 'keyed'; publicKey: string }
    | { mode: 'keyed'; proofHash: string; publicKey?: string }
    | { mode: 'keyless'; proofHash: string };

export type ExternalOAuthEndpointRequest = (
    path: string,
    init?: RequestInit,
    options?: Readonly<{
        includeAuth?: boolean;
        retry?: 'default' | 'none';
    }>,
) => Promise<Response>;

export type AccountDirectoryOAuthRequestContext = Readonly<{
    request: ExternalOAuthEndpointRequest;
    purpose: 'account_directory';
    endpointUrl: string;
    endpointServerIdentityId: string;
    canonicalServerUrl: string;
}>;

export type HomeOAuthRequestContext = Readonly<{
    request: ExternalOAuthEndpointRequest;
    target: Readonly<{
        serverUrl: string;
        serverId: string;
    }>;
}>;

export type HomeOAuthSignInRequestContext = HomeOAuthRequestContext & Readonly<{ signIn: true }>;

export type ExternalOAuthStart = Readonly<{ url: string; desktopAttemptId?: string }>;

/** OAuth started from an explicit Team entry. The server resolves the current
 * Team connection and mints the one-time admission continuation; the client
 * carries only the immutable Team ID. */
export type TeamOAuthRequestContext = Readonly<{
    request: ExternalOAuthEndpointRequest;
    purpose: 'team_admission';
    teamId: string;
    origin: 'home' | 'team';
    invitationToken?: string;
    target: Readonly<{
        serverUrl: string;
        serverId: string;
    }>;
}>;

export type TeamOAuthStart = ExternalOAuthStart & Readonly<{
    purpose: 'team_admission';
    teamId: string;
    admissionReference: string;
}>;

export type AccountDirectoryOAuthStart = ExternalOAuthStart & Readonly<{
    purpose: 'account_directory';
    credentialTarget: 'account_directory';
    endpointUrl: string;
    endpointServerIdentityId: string;
    canonicalServerUrl: string;
    expiresAt: number;
}>;

/**
 * The authenticated connect start.
 *
 * Without context it links a provider identity to the Account this device is
 * signed in as. With Team context it is the Team-admission entry for an Account
 * that already exists: the Team's identity is linked to that Account instead of
 * seeding a second, freshly provisioned one.
 */
export interface GetConnectUrl {
    (credentials: AuthCredentials): Promise<string>;
    (
        credentials: AuthCredentials,
        context: TeamOAuthRequestContext,
    ): Promise<TeamOAuthStart>;
}

export interface GetExternalAuthUrl {
    (params: ExternalAuthStartInput): Promise<string>;
    (
        params: ExternalAuthStartInput,
        context: HomeOAuthSignInRequestContext,
    ): Promise<ExternalOAuthStart>;
    (
        params: ExternalAuthStartInput,
        context: HomeOAuthRequestContext,
    ): Promise<string>;
    (
        params: ExternalAuthStartInput,
        context: TeamOAuthRequestContext,
    ): Promise<TeamOAuthStart>;
    (
        params: ExternalAuthStartInput,
        context: AccountDirectoryOAuthRequestContext,
    ): Promise<AccountDirectoryOAuthStart>;
}

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
    getExternalAuthUrl: GetExternalAuthUrl;
    getConnectUrl: GetConnectUrl;
    /** `context` routes the request to the exact Home that started the connect. */
    finalizeConnect: (
        credentials: AuthCredentials,
        params: { pending: string; username: string },
        context?: HomeOAuthRequestContext,
    ) => Promise<{ token?: string }>;
    cancelConnectPending: (credentials: AuthCredentials, pending: string, context?: HomeOAuthRequestContext) => Promise<void>;
    disconnect: (credentials: AuthCredentials) => Promise<void>;
}>;
