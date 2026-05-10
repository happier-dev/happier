import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
export type DesktopActivityOverlayActionTone = 'primary' | 'secondary' | 'danger';

export type DesktopActivityOverlayActionDescriptor = Readonly<{
    id: string;
    label: string;
    actionIdentifier: string;
    accessibilityLabel?: string | null;
    data?: Readonly<Record<string, unknown>>;
    tone?: DesktopActivityOverlayActionTone;
    iconName?: string | null;
    inputKind?: 'inline_text';
}>;

export type DesktopActivityOverlayCardKind =
    | 'idle_state'
    | 'permission_request'
    | 'user_question'
    | 'quota_summary'
    | 'session_overview'
    | 'completion_state'
    | 'multi_session_list';

export type DesktopActivityOverlayCollapsedSlideId =
    | 'status'
    | 'task_title'
    | 'last_tool'
    | 'project_duration';

export type DesktopActivityOverlayCollapsedSlidePriority =
    | 'idle'
    | 'running'
    | 'ready'
    | 'attention';

export type DesktopActivityOverlayCollapsedSlide = Readonly<{
    id: DesktopActivityOverlayCollapsedSlideId;
    title: string;
    subtitle: string | null;
    animatedEllipsis: boolean;
    priority: DesktopActivityOverlayCollapsedSlidePriority;
}>;

export type DesktopActivityOverlayCollapsedUrgency = Readonly<{
    level: 'idle' | 'running' | 'needs_you' | 'critical';
    unattendedMs: number;
    pollMs: number;
}>;

export type DesktopActivityOverlayCollapsedTransitionCue = Readonly<{
    kind: 'bounce_on_ready' | 'phase_flash';
    phase: DesktopActivityOverlayCollapsedSlidePriority;
    key: string;
    durationMs: number;
}>;

type DesktopActivityOverlayCardBase = Readonly<{
    id: string;
    kind: DesktopActivityOverlayCardKind;
    title: string;
    body?: string | null;
    eyebrow?: string | null;
    badgeText?: string | null;
    statusText?: string | null;
    actions?: readonly DesktopActivityOverlayActionDescriptor[];
}>;

export type DesktopActivityOverlayExpandedCard =
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'idle_state';
    }>)
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'permission_request';
        requestId: string;
        sessionId: string;
        serverId: string | null;
        summary: string | null;
        toolLabel: string;
        questionText: string | null;
        count: number;
        openActionIdentifier: string;
        allowActionIdentifier?: string;
        denyActionIdentifier?: string;
        risk?: 'low' | 'high';
    }>)
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'user_question';
        requestId: string;
        sessionId: string;
        serverId: string | null;
        summary: string | null;
        toolLabel: string;
        questionText: string | null;
        count: number;
        openActionIdentifier: string;
        allowActionIdentifier?: string;
        denyActionIdentifier?: string;
    }>)
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'quota_summary';
        summary: string | null;
    }>)
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'completion_state';
        sessionId: string;
        serverId: string | null;
        summary: string | null;
        openActionIdentifier: string;
        variant: 'turn_complete' | 'subagent_done' | 'pending_tool';
        autoDismissMs: number;
        sticky: boolean;
    }>)
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'session_overview';
        sessionId: string;
        serverId: string | null;
        subtitle: string | null;
        previewText: string | null;
        attentionState: string;
        active: boolean;
        updatedAt: number;
    }>)
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'multi_session_list';
        rows: readonly Readonly<{
            sessionId: string;
            serverId: string | null;
            title: string;
            subtitle: string | null;
            statusText: string | null;
            previewText: string | null;
        }>[];
    }>);

export type DesktopActivityOverlayModel = Readonly<{
    visible: boolean;
    isExpanded: boolean;
    generatedAt: number;
    collapsed: Readonly<{
        title: string;
        statusText: string | null;
        defaultTarget: string;
        sessionCount: number | null;
        primaryCardKind?: DesktopActivityOverlayCardKind | null;
        accentText?: string | null;
        slides?: readonly DesktopActivityOverlayCollapsedSlide[];
        carousel?: Readonly<{
            enabled: boolean;
            cadenceMs: number;
            freezeReason: 'disabled' | 'reduced_motion' | 'voice_over' | null;
        }>;
        urgency?: DesktopActivityOverlayCollapsedUrgency;
        transitionCue?: DesktopActivityOverlayCollapsedTransitionCue | null;
    }>;
    expanded: Readonly<{
        title: string;
        rows: readonly Readonly<{
            sessionId: string;
            serverId: string | null;
            title: string;
            subtitle: string | null;
            statusText: string | null;
            previewText: string | null;
        }>[];
        cards?: readonly DesktopActivityOverlayExpandedCard[];
        quickReply?: Readonly<{
            targetSessionId: string;
            serverId: string | null;
            phrases: readonly string[];
        }> | null;
    }>;
    window: Readonly<{
        collapsed: Readonly<{ width: number; height: number }>;
        expanded: Readonly<{ width: number; height: number }>;
    }>;
}>;

export type DesktopActivityOverlayWindowSizeParams = Readonly<{
    density: DesktopOverlayPolicy['density'];
    compactStyle: DesktopOverlayPolicy['compactStyle'];
    rowCount: number;
}>;
