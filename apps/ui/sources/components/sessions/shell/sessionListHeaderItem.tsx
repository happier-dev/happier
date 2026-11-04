import * as React from 'react';
import type { View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { t } from '@/text';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionListFirstGroupContext } from './SessionListGroup';
import { SessionSectionDraftField } from '@/components/sessions/organization/SessionSectionDraftField';
import { useSessionSectionDraftController } from '@/components/sessions/organization/useSessionSectionDraft';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';

import type { useSessionListRowMoveActionHandlers } from './useSessionListRowMoveActionHandlers';
import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { CollapsibleSectionHeader, ProjectGroupHeader, SessionSectionHeader } from './sessionListChrome';
import type { IconName } from '@/components/ui/icons/Icon';
import { useWorkspaceFaviconSourceReachable } from './useWorkspaceFavicon';
import type { RegisterSessionFolderDropTarget } from './useSessionListViewState';
import {
    SessionListHeaderFrame,
    type RegisterSessionListTreeRowBounds,
    type UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';
import { resolveSessionListHeaderViewState } from './resolveSessionListHeaderViewState';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';
import {
    resolveSessionListHeaderActionHandlers,
    type CreateSessionFromWorkspaceScopeHandler,
} from './resolveSessionListHeaderActionHandlers';
import {
    useSessionInlineDrag,
    type UseSessionInlineDragStart,
    type UseSessionInlineDragCancelEvent,
    type UseSessionInlineDragDropResultEvent,
    type UseSessionInlineDragResolvedDrop,
    type UseSessionInlineDragResolveDropResultEvent,
} from './useSessionInlineDrag';
import { useSessionListOrganizeMode } from './organize/SessionListOrganizeMode';
import { EntityDragGrip } from '@/components/ui/treeDragDrop/ui/EntityReleasePreview';
import { resolveWorkspaceRootTreeRowId, treeRowId } from './drop-resolution/treeRowId';
import { STAGE_SPOTLIGHT_TARGET_IDS } from '@/components/onboarding/tour/stage/stageSpotlightTargetIds';
import {
    useSpotlightTarget,
} from '@/components/onboarding/tour/stage/useSpotlightTarget';
import { Platform } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

type SessionListHeaderItemProps = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    /** The column's first group sits closer to the header. */
    first?: boolean;
    collapsedKeys: Readonly<Record<string, boolean>>;
    projectHeaderViewModelByGroupKey: ReadonlyMap<string, SessionListProjectHeaderViewModel>;
    hasMultipleMachines: boolean;
    onOpenProject: (workspaceRefId: string, serverId?: string) => void;
    onCreateSessionFromWorkspaceScope: CreateSessionFromWorkspaceScopeHandler;
    onAddFolderToWorkspace: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
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
    /** A section's own facts: its chosen icon and complete membership count (absent while unproven). */
    sectionFactsByGroupKey?: ReadonlyMap<string, SessionSectionHeaderFacts>;
    onCreateSessionInSection?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void;
    onRenameSection?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void | Promise<void>;
    onChangeSectionIcon?: (item: Extract<SessionListIndexItem, { type: 'header' }>, icon: IconName) => void | Promise<void>;
    onRemoveSection?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void | Promise<void>;
    onArchiveSection?: (item: Extract<SessionListIndexItem, { type: 'header' }>) => void | Promise<void>;
    getRowMoveActionHandlers?: ReturnType<typeof useSessionListRowMoveActionHandlers>;
    onRegisterSessionFolderDropTarget?: RegisterSessionFolderDropTarget;
    workspaceFaviconsEnabled?: boolean;
    workspaceMachineSubtitlesEnabled?: boolean;
    /** False in a Runs-only list, where no group is a place to start a Session. */
    newSessionEnabled?: boolean;
    overlayShared?: TreeDropOverlaySharedValues;
    onRegisterTreeRowBounds?: RegisterSessionListTreeRowBounds;
    onUnregisterTreeRowBounds?: UnregisterSessionListTreeRowBounds;
    onFolderDragStart?: UseSessionInlineDragStart;
    resolveDropResult?: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    onFolderDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    onFolderDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    onFolderDropResult?: (event: UseSessionInlineDragDropResultEvent) => void;
}>;

export type SessionSectionHeaderFacts = Readonly<{ icon: string | null; memberCount?: number; hasRowsInView?: boolean }>;

/**
 * A group header, and the inline New section field when the list is naming one where it will land
 * (lab `clsections:custom`). The fragment keeps one shape, so opening the field never remounts a header.
 */
export const SessionListHeaderItem = React.memo((props: SessionListHeaderItemProps) => {
    const draftController = useSessionSectionDraftController();
    const anchor = draftController?.draft ? draftController.anchor : null;
    const placement = anchor && anchor.groupKey === props.item.groupKey ? anchor.placement : null;
    const field = placement && draftController?.draft ? (
        <SessionSectionDraftField key={draftController.draft.key} draft={draftController.draft}
            onSubmit={draftController.submit} onCancel={draftController.cancel} />
    ) : null;
    return (
        <>
            {placement === 'before' ? field : null}
            <SessionListGroupHeaderItem {...props} />
            {placement === 'after' ? field : null}
        </>
    );
});

const SessionListGroupHeaderItem = React.memo((rawProps: SessionListHeaderItemProps) => {
    // The list's first group label opens the column only when nothing leads it (Scheduled, Drafts).
    const opensColumn = React.useContext(SessionListFirstGroupContext);
    const props = rawProps.first === true && !opensColumn ? { ...rawProps, first: false } : rawProps;
    const router = useRouter();
    const openNeedsYou = React.useCallback(() => {
        router.push({ pathname: '/inbox', params: { view: 'needs_you' } } as never);
    }, [router]);
    // The accepted baseline from the header VM (explicit null = none), and its Machine's reachability (P5 U5).
    const headerViewModel = props.item.headerKind === 'project'
        ? props.projectHeaderViewModelByGroupKey.get(props.item.groupKey ?? '') : undefined;
    const faviconSource = headerViewModel ? headerViewModel.scopeHint : undefined;
    const faviconSourceReachable = useWorkspaceFaviconSourceReachable(faviconSource, props.workspaceFaviconsEnabled === true);
    const stageSpotlightRef = React.useRef<View>(null);
    const stageSpotlightProps = useSpotlightTarget(
        stageSpotlightRef,
        props.item.headerKind === 'attention'
            ? STAGE_SPOTLIGHT_TARGET_IDS.attentionGroup
            : null,
    );

    const headerViewState = props.item.headerKind === 'folder' ? null : resolveSessionListHeaderViewState({
        item: props.item,
        collapsedKeys: props.collapsedKeys,
        projectHeaderViewModelByGroupKey: props.projectHeaderViewModelByGroupKey,
        translateServerHeader: (server) => t('sessionsList.serverHeader', { server }),
    });
    // Callback identity belongs to this mounted header. Global function-id caches
    // keep the outgoing list's closures alive after its column has been removed.
    const headerActionHandlers = React.useMemo(() => resolveSessionListHeaderActionHandlers({
        headerViewState,
        onOpenProject: props.onOpenProject,
        onCreateSessionFromWorkspaceScope: props.onCreateSessionFromWorkspaceScope,
        onRenameWorkspace: props.onRenameWorkspace,
        onResetWorkspaceName: props.onResetWorkspaceName,
        onToggleCollapse: props.onToggleCollapse,
    }), [headerViewState, props.onOpenProject, props.onCreateSessionFromWorkspaceScope,
        props.onRenameWorkspace, props.onResetWorkspaceName, props.onToggleCollapse]);

    if (props.item.headerKind === 'folder') {
        const collapseKey = props.item.groupKey ?? `folder:${props.item.folderId ?? props.item.title}`;
        const folderServerId = props.item.serverId ?? props.item.workspace?.serverId ?? null;
        const rowId = props.item.folderId && folderServerId
            ? treeRowId.folder(folderServerId, props.item.folderId)
            : null;
        const moveActionHandlers = rowId ? props.getRowMoveActionHandlers?.({
            sourceRowId: rowId, sourceLabel: props.item.title,
        }) : undefined;
        const sectionFacts = props.sectionFactsByGroupKey?.get(props.item.groupKey ?? '');
        const folderHeader = (
            <SessionSectionHeader
                title={props.item.title}
                icon={sectionFacts?.icon ?? null}
                memberCount={sectionFacts?.memberCount}
                hasRowsInView={sectionFacts?.hasRowsInView}
                collapsed={props.collapsedKeys[collapseKey] === true}
                onToggleCollapse={() => props.onToggleCollapse(collapseKey)}
                onNewSession={props.newSessionEnabled !== false && props.onCreateSessionInSection
                    ? () => props.onCreateSessionInSection?.(props.item) : undefined}
                onRename={() => props.onRenameSection?.(props.item)}
                onChangeIcon={(icon) => props.onChangeSectionIcon?.(props.item, icon)}
                onRemove={() => props.onRemoveSection?.(props.item)}
                onArchiveAll={props.onArchiveSection ? () => props.onArchiveSection?.(props.item) : undefined}
                onMove={moveActionHandlers?.onMoveToFolder}
                onMoveToWorkspaceRoot={moveActionHandlers?.onMoveToWorkspaceRoot}
                onMoveUp={moveActionHandlers?.onMoveUp}
                onMoveDown={moveActionHandlers?.onMoveDown}
                item={props.item}
                first={props.first}
                onRegisterDropTarget={props.onRegisterSessionFolderDropTarget}
            />
        );
        const framedFolderHeader = rowId && props.onRegisterTreeRowBounds && props.onUnregisterTreeRowBounds ? (
            <SessionListHeaderFrame
                treeRowId={rowId}
                onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
                onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            >
                {folderHeader}
            </SessionListHeaderFrame>
        ) : folderHeader;
        // `rowId` is the drag identity; without a resolved Home there is no stable key to drag under.
        if (!rowId || !props.item.folderId || !props.overlayShared || !props.resolveDropResult || !props.onFolderDropResult) {
            return framedFolderHeader;
        }
        return (
            <DraggableFolderHeaderFrame
                title={props.item.title}
                sessionKey={rowId}
                groupKey={props.item.groupKey ?? `folder:${props.item.folderId}`}
                overlayShared={props.overlayShared}
                onDragStart={props.onFolderDragStart}
                onDragUpdate={props.onFolderDragUpdate}
                onDragCancel={props.onFolderDragCancel}
                resolveDropResult={props.resolveDropResult}
                onDropResult={props.onFolderDropResult}
            >
                {framedFolderHeader}
            </DraggableFolderHeaderFrame>
        );
    }

    if (!headerViewState || !headerActionHandlers) {
        return null;
    }

    if (headerViewState.kind === 'project') {
        const rowId = resolveWorkspaceRootTreeRowId(props.item, headerViewState.displayTitle);
        const projectHeaderViewModel = props.projectHeaderViewModelByGroupKey.get(props.item.groupKey ?? '');
        const moveActionHandlers = props.getRowMoveActionHandlers?.({
            sourceRowId: rowId, sourceLabel: headerViewState.displayTitle,
        });
        const projectHeader = (
            <ProjectGroupHeader
                item={props.item}
                faviconSource={faviconSource}
                faviconSourceReachable={faviconSourceReachable}
                machineSubtitle={projectHeaderViewModel?.machineSubtitle}
                hasMultipleMachines={props.hasMultipleMachines}

                displayTitle={headerViewState.displayTitle}
                hasCustomLabel={headerViewState.hasCustomLabel}
                canOpenProject={Boolean(headerViewState.workspaceRefId)}
                workspaceFaviconsEnabled={props.workspaceFaviconsEnabled === true}
                workspaceMachineSubtitlesEnabled={props.workspaceMachineSubtitlesEnabled !== false}
                newSessionEnabled={props.newSessionEnabled !== false}
                onOpenProject={headerActionHandlers.onOpenProject}
                onCreateSession={headerActionHandlers.onCreateSession}
                onAddFolder={() => props.onAddFolderToWorkspace(props.item)}
                onRename={headerActionHandlers.onRename}
                onReset={headerActionHandlers.onReset}
                onMoveUp={moveActionHandlers?.onMoveUp}
                onMoveDown={moveActionHandlers?.onMoveDown}
                first={props.first}
                collapsed={headerViewState.collapsed}
                onToggleCollapse={headerActionHandlers.onToggleCollapse}
                onRegisterDropTarget={props.onRegisterSessionFolderDropTarget}
            />
        );
        const framedProjectHeader = props.onRegisterTreeRowBounds && props.onUnregisterTreeRowBounds ? (
            <SessionListHeaderFrame
                treeRowId={rowId}
                onRegisterTreeRowBounds={props.onRegisterTreeRowBounds}
                onUnregisterTreeRowBounds={props.onUnregisterTreeRowBounds}
            >
                {projectHeader}
            </SessionListHeaderFrame>
        ) : projectHeader;
        if (!props.item.workspaceScopeHint || !props.overlayShared || !props.resolveDropResult || !props.onFolderDropResult) {
            return framedProjectHeader;
        }
        return (
            <DraggableFolderHeaderFrame
                title={headerViewState.displayTitle}
                sessionKey={rowId}
                groupKey={props.item.groupKey ?? props.item.workspaceKey ?? headerViewState.displayTitle}
                overlayShared={props.overlayShared}
                onDragStart={props.onFolderDragStart}
                onDragUpdate={props.onFolderDragUpdate}
                onDragCancel={props.onFolderDragCancel}
                resolveDropResult={props.resolveDropResult}
                onDropResult={props.onFolderDropResult}
            >
                {framedProjectHeader}
            </DraggableFolderHeaderFrame>
        );
    }

    const isPrimaryHeader = isSessionListPrimaryHeaderKind(props.item.headerKind);
    const headerTestIdKey = isPrimaryHeader
        ? (props.item.groupKey ?? props.item.headerKind)
        : props.item.headerKind;

    const header = (
        <CollapsibleSectionHeader
            title={headerViewState.title}
            collapsed={headerViewState.collapsed}
            onPress={headerActionHandlers.onToggleCollapse}
            // Needs you opens the Inbox's Needs you view (R8); its chevron alone folds the group.
            onOpen={props.item.headerKind === 'attention' ? openNeedsYou : undefined}
            headerKind={props.item.headerKind}
            rollup={props.item.rollup}
            count={props.item.headerKind === 'attention' || props.item.headerKind === 'working' ? props.item.eligibleCount : undefined}
            first={props.first}
            testID={headerTestIdKey ? `session-list-header:${headerTestIdKey}` : undefined}
            rootMeasurement={props.item.headerKind === 'attention' ? {
                active: stageSpotlightProps.active,
                ref: stageSpotlightRef,
                onLayout: stageSpotlightProps.onLayout,
                style: stageSpotlightProps.style,
            } : undefined}
        />
    );
    return header;
});

const DraggableFolderHeaderFrame = React.memo(function DraggableFolderHeaderFrame(props: Readonly<{
    title: string;
    sessionKey: string;
    groupKey: string;
    overlayShared: TreeDropOverlaySharedValues;
    onDragStart?: UseSessionInlineDragStart;
    onDragUpdate?: (event: UseSessionInlineDragDropResultEvent) => void;
    onDragCancel?: (event: UseSessionInlineDragCancelEvent) => void;
    resolveDropResult: (event: UseSessionInlineDragResolveDropResultEvent) => UseSessionInlineDragResolvedDrop;
    onDropResult: (event: UseSessionInlineDragDropResultEvent) => void;
    children: React.ReactNode;
}>) {
    // Desktop headers carry themselves; a phone header carries only in Organize mode (K1).
    const organize = useSessionListOrganizeMode();
    const touchPrimary = useHappierTouchPrimaryPointer(Platform.OS);
    const enabled = Boolean(props.onDropResult) && (!touchPrimary || organize.active);
    const { gesture, animatedStyle, dragSourceRef } = useSessionInlineDrag({
        enabled,
        sessionKey: props.sessionKey,
        groupKey: props.groupKey,
        overlayShared: props.overlayShared,
        onDragStart: props.onDragStart ?? (() => {}),
        onDragUpdate: props.onDragUpdate,
        onDragCancel: props.onDragCancel,
        resolveDropResult: props.resolveDropResult,
        onDropResult: props.onDropResult,
    });
    const content = (
        <Animated.View ref={dragSourceRef} style={[animatedStyle, { flexDirection: 'row', alignItems: 'center' }]}>
            <Animated.View style={{ flex: 1 }}>{props.children}</Animated.View>
            {touchPrimary && organize.active && gesture ? (
                <GestureDetector gesture={gesture}>
                    <EntityDragGrip density="touch" accessibilityLabel={t('entityDragDrop.organize.grip', { item: props.title })}
                        testID={`session-list-header-drag-grip:${props.sessionKey}`} />
                </GestureDetector>
            ) : null}
        </Animated.View>
    );
    return content;
});
