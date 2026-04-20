import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';

export type DesktopActivityOverlaySnapshotState = 'idle' | 'content';

export type DesktopActivityOverlaySessionSnapshot = Pick<
    ActivitySurfaceSessionViewModel,
    'sessionId' | 'title' | 'subtitle' | 'statusText' | 'previewText' | 'attentionState'
> & Readonly<{
    active: boolean;
    updatedAt: number;
}>;

export type DesktopActivityOverlayRequestSnapshot = Readonly<{
    kind: 'permission_request' | 'user_question';
    requestId: string;
    sessionId: string;
    title: string;
    summary: string | null;
    toolLabel: string;
    questionText: string | null;
    count: number;
    openActionIdentifier: string;
    allowActionIdentifier?: string;
    denyActionIdentifier?: string;
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
    title: string;
    summary: string | null;
    openActionIdentifier: string;
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
    defaultTarget: string;
    labels: DesktopActivityOverlaySnapshotLabels;
}>;

export type DesktopActivityOverlayCandidateSource = Readonly<{
    candidate: SessionActivityAttention;
    viewModel: ActivitySurfaceSessionViewModel;
}>;
