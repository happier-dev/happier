import * as React from 'react';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { t } from '@/text';

import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { CollapsibleSectionHeader, ProjectGroupHeader } from './sessionListChrome';
import { resolveSessionListHeaderViewState } from './resolveSessionListHeaderViewState';
import {
    resolveSessionListHeaderActionHandlers,
    type CreateSessionFromWorkspaceScopeHandler,
} from './resolveSessionListHeaderActionHandlers';

type SessionListHeaderItemProps = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    collapsedKeys: Readonly<Record<string, boolean>>;
    projectHeaderViewModelByGroupKey: ReadonlyMap<string, SessionListProjectHeaderViewModel>;
    hasMultipleMachines: boolean;
    onOpenProject: (workspaceRefId: string) => void;
    onCreateSessionFromWorkspaceScope: CreateSessionFromWorkspaceScopeHandler;
    onRenameWorkspace: (params: Readonly<{
        legacyWorkspaceKey: string;
        scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        currentLabel: string;
    }>) => void;
    onResetWorkspaceName: (params: Readonly<{
        legacyWorkspaceKey: string;
        scopeHint: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
    }>) => void;
    onToggleCollapse: (collapseKey: string) => void;
}>;

export const SessionListHeaderItem = React.memo((props: SessionListHeaderItemProps) => {
    const headerViewState = resolveSessionListHeaderViewState({
        item: props.item,
        collapsedKeys: props.collapsedKeys,
        projectHeaderViewModelByGroupKey: props.projectHeaderViewModelByGroupKey,
        translateServerHeader: (server) => t('sessionsList.serverHeader', { server }),
    });
    const headerActionHandlers = resolveSessionListHeaderActionHandlers({
        headerViewState,
        onOpenProject: props.onOpenProject,
        onCreateSessionFromWorkspaceScope: props.onCreateSessionFromWorkspaceScope,
        onRenameWorkspace: props.onRenameWorkspace,
        onResetWorkspaceName: props.onResetWorkspaceName,
        onToggleCollapse: props.onToggleCollapse,
    });

    if (!headerViewState || !headerActionHandlers) {
        return null;
    }

    if (headerViewState.kind === 'project') {
        return (
            <ProjectGroupHeader
                item={props.item}
                hasMultipleMachines={props.hasMultipleMachines}
                displayTitle={headerViewState.displayTitle}
                hasCustomLabel={headerViewState.hasCustomLabel}
                canOpenProject={Boolean(headerViewState.workspaceRefId)}
                onOpenProject={headerActionHandlers.onOpenProject}
                onCreateSession={headerActionHandlers.onCreateSession}
                onRename={headerActionHandlers.onRename}
                onReset={headerActionHandlers.onReset}
                collapsed={headerViewState.collapsed}
                onToggleCollapse={headerActionHandlers.onToggleCollapse}
            />
        );
    }

    return (
        <CollapsibleSectionHeader
            title={headerViewState.title}
            collapsed={headerViewState.collapsed}
            onPress={headerActionHandlers.onToggleCollapse}
            showOrderingMenu={props.item.headerKind === 'active' || props.item.headerKind === 'inactive'}
        />
    );
});
