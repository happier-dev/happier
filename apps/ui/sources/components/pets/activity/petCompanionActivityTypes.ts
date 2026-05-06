import type { PetAnimationStateV1 } from '@happier-dev/protocol';

import type { Session } from '@/sync/domains/state/storageTypes';

export type PetCompanionActivityStatus =
    Extract<PetAnimationStateV1, 'waiting' | 'failed' | 'review' | 'running' | 'idle'>;

export type PetCompanionActivityReason = PetCompanionActivityStatus;

export type PetCompanionSessionSignals = Readonly<{
    hasFailure: boolean;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
    hasUnreadMessages: boolean;
    latestThinkingActivityAtMs: number | null;
    latestMeaningfulActivityAtMs: number | null;
    lastMessageSubtitle?: string | null;
    pendingMessageCount: number;
}>;

export type PetCompanionTrayItem = Readonly<{
    id: string;
    dismissKey: string;
    sessionId: string;
    status: Exclude<PetCompanionActivityStatus, 'idle'>;
    priority: number;
    title: string;
    subtitle: string | null;
    activityAtMs: number | null;
    expiresAtMs: number | null;
    actions: Readonly<{
        open: true;
        dismiss: true;
        quickReply: true;
    }>;
}>;

export type PetCompanionActivityModel = Readonly<{
    state: PetCompanionActivityStatus;
    reason: PetCompanionActivityReason;
    sessionId: string | null;
    trayItems: readonly PetCompanionTrayItem[];
}>;

export type BuildPetCompanionActivityModelInput = Readonly<{
    sessions: readonly Session[];
    selectedSessionId?: string | null;
    signalsBySessionId?: Readonly<Record<string, PetCompanionSessionSignals | undefined>>;
    dismissedTrayItemKeys?: ReadonlySet<string> | readonly string[];
    nowMs?: number;
}>;
