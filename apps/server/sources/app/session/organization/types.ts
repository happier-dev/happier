import type { Prisma } from "@prisma/client";

export type SessionOrganizationTx = Prisma.TransactionClient;

export interface SessionOrganizationPinRecord {
    readonly sessionId: string;
    readonly sortKey: string | null;
    readonly pinnedAt: Date;
}

export interface SessionAttentionStandingRecord {
    readonly sessionId: string;
    readonly standing: boolean;
    readonly updatedAt: Date;
}

export interface SessionOrganizationFolderRecord {
    readonly id: string;
    readonly folderKey: string;
    readonly parentKey: string | null;
    readonly sortKey: string | null;
    readonly displayDbValue: string | null;
    readonly archivedAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

export interface SessionOrganizationTagRecord {
    readonly id: string;
    readonly tagKey: string;
    readonly sortKey: string | null;
    readonly displayDbValue: string | null;
    readonly archivedAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}

export interface SessionOrganizationOrderEntryRecord {
    readonly scopeKind: string;
    readonly scopeKey: string;
    readonly itemKind: string;
    readonly itemKey: string;
    readonly sortKey: string;
}

export interface SessionOrganizationLabelRecord {
    readonly labelKind: string;
    readonly scopeKey: string;
    readonly displayDbValue: string | null;
    readonly archivedAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
}
