import { ImageRef } from "./storage/files";
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
    connectedServices: string[];
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
