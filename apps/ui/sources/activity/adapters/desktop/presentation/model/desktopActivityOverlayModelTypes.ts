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
}>;

export type DesktopActivityOverlayCardKind =
    | 'idle_state'
    | 'permission_request'
    | 'user_question'
    | 'quota_summary'
    | 'session_overview'
    | 'completion_state'
    | 'multi_session_list';

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
        summary: string | null;
        toolLabel: string;
        questionText: string | null;
        count: number;
        openActionIdentifier: string;
        allowActionIdentifier?: string;
        denyActionIdentifier?: string;
    }>)
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'user_question';
        requestId: string;
        sessionId: string;
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
        summary: string | null;
        openActionIdentifier: string;
    }>)
    | (DesktopActivityOverlayCardBase & Readonly<{
        kind: 'session_overview';
        sessionId: string;
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
    }>;
    expanded: Readonly<{
        title: string;
        rows: readonly Readonly<{
            sessionId: string;
            title: string;
            subtitle: string | null;
            statusText: string | null;
            previewText: string | null;
        }>[];
        cards?: readonly DesktopActivityOverlayExpandedCard[];
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
