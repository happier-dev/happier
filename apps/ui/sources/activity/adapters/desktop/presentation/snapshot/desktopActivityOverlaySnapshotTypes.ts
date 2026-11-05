import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import type { WorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import type { NotchBotFaces, PinnedDesktopOverlayConversation } from '../notchBotTypes';
import type { SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import type { SessionPermissionChoice } from '@/sync/ops/sessionPermissionChoices';

export type DesktopActivityOverlaySnapshotState = 'idle' | 'content';

/**
 * What the overlay realm needs to draw a Session's identity and state without a Session store: the
 * work-status tone (colour means state) and the Agent mark's inputs. Absent fields draw a neutral row
 * without a mark.
 */
export type DesktopActivityOverlaySessionIdentity = Readonly<{
    tone?: WorkStatusTone;
    agentId?: string | null;
    machineId?: string | null;
    /** A Bot Session's face; the row draws it in place of the Agent mark. */
    botFace?: SessionBotFaceFacts | null;
}>;

export type DesktopActivityOverlaySessionSnapshot = Pick<
    ActivitySurfaceSessionViewModel,
    'sessionId' | 'serverId' | 'title' | 'subtitle' | 'statusText' | 'previewText' | 'attentionState'
> & Readonly<{
    active: boolean;
    updatedAt: number;
}> & DesktopActivityOverlaySessionIdentity;

/**
 * What a permission request acts on, when its tool names one: the file (with its line delta when the
 * request carries the change) or the command. The card draws the kind as its title and this as its
 * monospace line (lab `ntdock-T` ask: "Edit a file · .github/quarantine.json +1 −0").
 */
export type DesktopActivityOverlayRequestSubject = Readonly<{
    kind: 'edit' | 'write' | 'read' | 'command';
    text: string;
    additions: number | null;
    deletions: number | null;
}>;

export type DesktopActivityOverlayRequestSnapshot = Readonly<{
    kind: 'permission_request' | 'user_question';
    activityInstanceId: string;
    requestId: string;
    turnId?: string;
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
    permissionChoices?: readonly SessionPermissionChoice[];
    subject?: DesktopActivityOverlayRequestSubject | null;
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
    bots: NotchBotFaces;
    conversation: PinnedDesktopOverlayConversation | null;
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
