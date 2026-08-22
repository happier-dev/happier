import type {
    ConnectedServiceCredentialRevisionV1,
    ConnectedServiceId,
    QualifiedConnectedAccountGroupV4,
    QualifiedConnectedAccountProfileV4,
} from "@happier-dev/protocol";

import { ImageRef } from "./storage/blob/files";
import type { LinkedProvider } from "./app/auth/providers/linkedProviders";

export type AccountProfile = {
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: ImageRef | null;
    linkedProviders: LinkedProvider[];
    settings: {
        value: string | null;
        version: number;
    } | null;
    settingsV2?: {
        content: unknown | null;
        version: number;
    } | null;
    connectedServices: string[];
    connectedServicesV2?: Array<{
        serviceId: string;
        profiles: Array<{
            profileId: string;
            status: "connected" | "refreshing" | "needs_reauth" | "refresh_failed_retryable";
            kind?: "oauth" | "token" | null;
            providerEmail?: string | null;
            providerAccountId?: string | null;
            expiresAt?: number | null;
            lastUsedAt?: number | null;
        }>;
        groups?: Array<{
            groupId: string;
            displayName?: string | null;
            activeProfileId?: string | null;
            generation?: number;
            memberProfileIds?: string[];
        }>;
    }>;
    /**
     * Legacy credential-revision projection and native Account V4 truth travel on
     * the same `update-account` payload the account-profile route returns. They are
     * declared here so a future object-literal or `Pick` producer cannot silently
     * drop them from the socket projection: the V4 arrays are the only carrier for
     * a qualified service that has no legacy scalar shadow.
     */
    connectedServiceCredentialRevisionsV1?: Array<{
        serviceId: ConnectedServiceId;
        profileId: string;
        credentialRevision: ConnectedServiceCredentialRevisionV1;
    }>;
    connectedAccountsV4?: QualifiedConnectedAccountProfileV4[];
    connectedAccountGroupsV4?: QualifiedConnectedAccountGroupV4[];
}

export type ArtifactInfo = {
    id: string;
    header: string;
    headerVersion: number;
    dataEncryptionKey: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
}

export type Artifact = ArtifactInfo & {
    body: string;
    bodyVersion: number;
}
