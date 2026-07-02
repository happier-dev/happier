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
