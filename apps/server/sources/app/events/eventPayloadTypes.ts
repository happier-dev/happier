import { Socket } from "socket.io";
import type { LinkedProvider } from "@/app/auth/providers/linkedProviders";

// === CONNECTION TYPES ===

export interface SessionScopedConnection {
    connectionType: 'session-scoped';
    socket: Socket;
    userId: string;
    sessionId: string;
}

export interface UserScopedConnection {
    connectionType: 'user-scoped';
    socket: Socket;
    userId: string;
}

export interface MachineScopedConnection {
    connectionType: 'machine-scoped';
    socket: Socket;
    userId: string;
    machineId: string;
}

export type ClientConnection = SessionScopedConnection | UserScopedConnection | MachineScopedConnection;

// === RECIPIENT FILTER TYPES ===

export type RecipientFilter =
    | { type: 'all-interested-in-session'; sessionId: string }
    | { type: 'user-scoped-only' }
    // Note: despite the name, this intentionally includes the user's `user-scoped:*` room as well as their per-account
    // machine room. This avoids relying on the global `user:*` room for machine-daemon connections.
    | { type: 'machine-scoped-only'; machineId: string }
    | { type: 'all-user-authenticated-connections' };

// === UPDATE EVENT TYPES (Persistent) ===

export type UpdateEvent = {
    type: 'new-message';
    sessionId: string;
    message: {
        id: string;
        seq: number;
        content: any;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }
} | {
    type: 'new-session';
    sessionId: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-session';
    sessionId: string;
    metadata?: {
        value: string | null;
        version: number;
    } | null | undefined;
    agentState?: {
        value: string | null;
        version: number;
    } | null | undefined;
} | {
    type: 'pending-changed';
    sessionId: string;
    pendingVersion: number;
    pendingCount: number;
    changedByAccountId?: string;
} | {
    type: 'automation-upsert';
    automationId: string;
    version: number;
    enabled: boolean;
    updatedAt: number;
} | {
    type: 'automation-delete';
    automationId: string;
    deletedAt: number;
} | {
    type: 'automation-run-updated';
    runId: string;
    automationId: string;
    state: 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
    scheduledAt: number;
    startedAt?: number | null;
    finishedAt?: number | null;
    updatedAt: number;
    machineId?: string | null;
} | {
    type: 'automation-assignment-updated';
    machineId: string;
    automationId: string;
    enabled: boolean;
    updatedAt: number;
} | {
    type: 'update-account';
    userId: string;
    settings?: {
        value: string | null;
        version: number;
    } | null | undefined;
    linkedProviders?: LinkedProvider[] | undefined;
} | {
    type: 'new-machine';
    machineId: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-machine';
    machineId: string;
    metadata?: {
        value: string;
        version: number;
    };
    daemonState?: {
        value: string;
        version: number;
    };
    activeAt?: number;
} | {
    type: 'new-artifact';
    artifactId: string;
    seq: number;
    header: string;
    headerVersion: number;
    body: string;
    bodyVersion: number;
    dataEncryptionKey: string | null;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-artifact';
    artifactId: string;
    header?: {
        value: string;
        version: number;
    };
    body?: {
        value: string;
        version: number;
    };
} | {
    type: 'delete-artifact';
    artifactId: string;
} | {
    type: 'delete-session';
    sessionId: string;
} | {
    type: 'relationship-updated';
    uid: string;
    status: 'none' | 'requested' | 'pending' | 'friend' | 'rejected';
    timestamp: number;
} | {
    type: 'new-feed-post';
    id: string;
    body: any;
    cursor: string;
    createdAt: number;
} | {
    type: 'kv-batch-update';
    changes: Array<{
        key: string;
        value: string | null; // null indicates deletion
        version: number; // -1 for deleted keys
    }>;
} | {
    type: 'session-shared';
    sessionId: string;
    shareId: string;
    sharedBy: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: any | null;
    };
    accessLevel: 'view' | 'edit' | 'admin';
    encryptedDataKey: string;
    createdAt: number;
} | {
    type: 'session-share-updated';
    sessionId: string;
    shareId: string;
    accessLevel: 'view' | 'edit' | 'admin';
    updatedAt: number;
} | {
    type: 'session-share-revoked';
    sessionId: string;
    shareId: string;
} | {
    type: 'public-share-created';
    sessionId: string;
    publicShareId: string;
    token: string;
    expiresAt: number | null;
    maxUses: number | null;
    isConsentRequired: boolean;
    createdAt: number;
} | {
    type: 'public-share-updated';
    sessionId: string;
    publicShareId: string;
    expiresAt: number | null;
    maxUses: number | null;
    isConsentRequired: boolean;
    updatedAt: number;
} | {
    type: 'public-share-deleted';
    sessionId: string;
};

// === EPHEMERAL EVENT TYPES (Transient) ===

export type EphemeralEvent = {
    type: 'activity';
    id: string;
    active: boolean;
    activeAt: number;
    thinking?: boolean;
} | {
    type: 'machine-activity';
    id: string;
    active: boolean;
    activeAt: number;
} | {
    type: 'usage';
    id: string;
    key: string;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    timestamp: number;
} | {
    type: 'machine-status';
    machineId: string;
    online: boolean;
    timestamp: number;
};

// === EVENT PAYLOAD TYPES ===

export interface UpdatePayload {
    id: string;
    seq: number;
    body: {
        t: UpdateEvent['type'];
        [key: string]: any;
    };
    createdAt: number;
}

export interface EphemeralPayload {
    type: EphemeralEvent['type'];
    [key: string]: any;
}
