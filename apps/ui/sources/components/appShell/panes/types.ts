import type * as React from 'react';

export type PaneId = 'right' | 'details' | 'bottom';

export type PaneScopeId = string;

export type PaneResource =
    | Readonly<{ kind: 'file'; path: string }>
    | Readonly<{ kind: 'commit'; commitHash: string }>
    | Readonly<{ kind: 'diff'; path: string; baseRef?: string | null }>
    | Readonly<{ kind: string; [key: string]: unknown }>;

export type PaneDriver = Readonly<{
    scopeId: PaneScopeId;
    renderRightPane?: (ctx: Readonly<{ scopeId: PaneScopeId }>) => React.ReactNode;
    renderDetailsPane?: (ctx: Readonly<{ scopeId: PaneScopeId }>) => React.ReactNode;
    renderBottomPane?: (ctx: Readonly<{ scopeId: PaneScopeId }>) => React.ReactNode;
    openResource?: (resource: PaneResource) => void;
    onScopeDeactivated?: () => void;
}>;
