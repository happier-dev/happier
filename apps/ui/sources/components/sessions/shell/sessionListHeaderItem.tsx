import * as React from 'react';

import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { t } from '@/text';

import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { CollapsibleSectionHeader, ProjectGroupHeader } from './sessionListChrome';
import { resolveSessionListHeaderViewState } from './resolveSessionListHeaderViewState';

type SessionListHeaderItemProps = Readonly<{
    item: Extract<SessionListViewItem, { type: 'header' }>;
    collapsedKeys: Readonly<Record<string, boolean>>;
    projectHeaderViewModelByGroupKey: ReadonlyMap<string, SessionListProjectHeaderViewModel>;
    hasMultipleMachines: boolean;
    onOpenProject: (workspaceRefId: string) => void;
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

    if (headerViewState?.kind === 'project') {
        return (
            <ProjectGroupHeader
                item={props.item}
                hasMultipleMachines={props.hasMultipleMachines}
                displayTitle={headerViewState.displayTitle}
                hasCustomLabel={headerViewState.hasCustomLabel}
                canOpenProject={Boolean(headerViewState.workspaceRefId)}
                onOpenProject={() => {
                    if (!headerViewState.workspaceRefId) return;
                    props.onOpenProject(headerViewState.workspaceRefId);
                }}
                onRename={() => props.onRenameWorkspace({
                    legacyWorkspaceKey: headerViewState.legacyWorkspaceKey,
                    scopeHint: headerViewState.scopeHint,
                    currentLabel: headerViewState.displayTitle,
                })}
                onReset={() => props.onResetWorkspaceName({
                    legacyWorkspaceKey: headerViewState.legacyWorkspaceKey,
                    scopeHint: headerViewState.scopeHint,
                })}
                collapsed={headerViewState.collapsed}
                onToggleCollapse={() => props.onToggleCollapse(headerViewState.collapseKey)}
            />
        );
    }

    if (!headerViewState) return null;

    return (
        <CollapsibleSectionHeader
            title={headerViewState.title}
            collapsed={headerViewState.collapsed}
            onPress={() => props.onToggleCollapse(headerViewState.collapseKey)}
        />
    );
});
