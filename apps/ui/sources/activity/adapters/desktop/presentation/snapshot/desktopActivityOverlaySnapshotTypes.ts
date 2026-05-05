import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';

export type DesktopActivityOverlaySnapshotState = 'idle' | 'content';

export type DesktopActivityOverlayCompanionAnimationState =
    | 'idle'
    | 'running-right'
    | 'running-left'
    | 'waving'
    | 'jumping'
    | 'failed'
    | 'waiting'
    | 'running'
    | 'review';

export type DesktopActivityOverlayCompanionAttentionLevel =
    | 'idle'
    | 'active'
    | 'needsAttention'
    | 'failed';

export type DesktopActivityOverlayCompanionReason =
    | 'idle'
    | 'waiting'
    | 'failed'
    | 'review'
    | 'running'
    | 'queued'
    | 'live_activity'
    | 'attention_required'
    | 'unread_activity'
    | 'failure';

export type DesktopActivityOverlayCompanionPet = Readonly<{
    source: SelectedPetPackageSource;
    displayName: string;
}>;

export type DesktopActivityOverlayCompanionSnapshot = Readonly<{
    enabled: boolean;
    pet: DesktopActivityOverlayCompanionPet;
    state: DesktopActivityOverlayCompanionAnimationState;
    attentionLevel: DesktopActivityOverlayCompanionAttentionLevel;
    reason: DesktopActivityOverlayCompanionReason;
    sessionId: string | null;
}>;

export type DesktopActivityOverlaySessionSnapshot = Pick<
    ActivitySurfaceSessionViewModel,
    'sessionId' | 'serverId' | 'title' | 'subtitle' | 'statusText' | 'previewText' | 'attentionState'
> & Readonly<{
    active: boolean;
    updatedAt: number;
}>;

export type DesktopActivityOverlayRequestSnapshot = Readonly<{
    kind: 'permission_request' | 'user_question';
    requestId: string;
    sessionId: string;
    serverId: string | null;
    title: string;
    summary: string | null;
    toolLabel: string;
    questionText: string | null;
    count: number;
    openActionIdentifier: string;
    allowActionIdentifier?: string;
    denyActionIdentifier?: string;
    risk?: 'low' | 'high';
    directOptions: readonly Readonly<{
        id: string;
        label: string;
        description: string | null;
        actionIdentifier: string;
        answers: readonly Readonly<{
            question: string;
            answer: string;
        }>[];
    }>[];
}>;

export type DesktopActivityOverlayQuotaSummarySnapshot = Readonly<{
    id: string;
    title: string;
    summary: string | null;
}>;

export type DesktopActivityOverlayCompletionStateSnapshot = Readonly<{
    sessionId: string;
    serverId: string | null;
    title: string;
    summary: string | null;
    openActionIdentifier: string;
    variant: 'turn_complete' | 'subagent_done' | 'pending_tool';
    autoDismissMs: number;
    sticky: boolean;
}>;

export type DesktopActivityOverlaySnapshotLabels = Readonly<{
    sessionsTitle: string;
    emptyTitle: string;
}>;

export type DesktopActivityOverlaySnapshot = Readonly<{
    version: 1;
    generatedAt: number;
    state: DesktopActivityOverlaySnapshotState;
    counts: ActivityOverviewSnapshot['counts'];
    summaryCounts: Readonly<{
        attentionCount: number;
        runningCount: number;
        permissionCount: number;
    }>;
    primary: DesktopActivityOverlaySessionSnapshot | null;
    sessions: readonly DesktopActivityOverlaySessionSnapshot[];
    permissionRequests: readonly DesktopActivityOverlayRequestSnapshot[];
    userQuestions: readonly DesktopActivityOverlayRequestSnapshot[];
    quotaSummaries: readonly DesktopActivityOverlayQuotaSummarySnapshot[];
    completionStates: readonly DesktopActivityOverlayCompletionStateSnapshot[];
    companion: DesktopActivityOverlayCompanionSnapshot;
    defaultTarget: string;
    labels: DesktopActivityOverlaySnapshotLabels;
}>;

export type DesktopActivityOverlayCandidateSource = Readonly<{
    candidate: SessionActivityAttention;
    viewModel: ActivitySurfaceSessionViewModel;
}>;
