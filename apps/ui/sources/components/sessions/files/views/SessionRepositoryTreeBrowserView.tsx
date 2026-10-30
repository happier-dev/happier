import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { WorkspaceRepositoryTreeBrowserView } from '@/components/projects/files/WorkspaceRepositoryTreeBrowserView';
import { hrefForDestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineDisplayIdentity } from '@/components/sessions/model/useSessionMachineTarget';
import type { CheckoutMachineScope } from '@/components/workspaces/reachability/checkoutReachability';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import { storage, useSessionDirectoryKind, useSessionProjectScmSnapshot, useSessionRepositoryTreeExpandedPaths, useSessionServerId, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import { RepositoryTreeRootErrorState } from '@/components/workspaces/files/repositoryTree/RepositoryTreeRootErrorState';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HAPPIER_TREE_ROW_METRICS as TREE_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import { usePaneHeaderSlotContent, type PaneHeaderLine, type PaneHeaderLineSegment } from '@/components/appShell/panes/paneHeaderSlot';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { leafFolderName } from '@/utils/path/pathUtils';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { RepositoryTreeCreateMenu } from '@/components/workspaces/files/repositoryTree/RepositoryTreeCreateMenu';
import type { FileMenuContext } from '@/components/workspaces/files/file/fileMenus';
import { applyFileDiscardAction } from '@/scm/operations/applyFileDiscardAction';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

const styles = StyleSheet.create({
    root: { flex: 1 },
    sessionFilesRoot: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: TREE_ROW_METRICS.basePaddingPx, paddingRight: 12 },
});

function SessionFilesRootHeading(props: Readonly<{ label: string }>) {
    const { theme } = useUnistyles();
    return (
        <View testID="repository-tree-session-files-root" accessibilityRole="header" style={[styles.sessionFilesRoot,
            { minHeight: isTouchPrimaryPointer() ? TREE_ROW_METRICS.minHeightPx.touch : TREE_ROW_METRICS.minHeightPx.precise }]}>
            <Icon name="folder" size={16} color={theme.colors.text.secondary} />
            <Text numberOfLines={1} style={[Typography.variant('label', 'semiBold'), { color: theme.colors.text.primary }]}>{props.label}</Text>
        </View>
    );
}

const ignoreUnavailableAction = () => {};
function UnavailableSessionFiles(props: Readonly<{
    rootLabel: string;
    machineName: string | null;
    machineScope: CheckoutMachineScope | null;
    paneHeaderLine: PaneHeaderLine | null;
}>) {
    const action = React.useMemo(() => <RepositoryTreeCreateMenu createEnabled={false} uploadEnabled={false} isWeb={Platform.OS === 'web'}
        uploadDestinationLabel={props.rootLabel} onSelect={ignoreUnavailableAction} />, [props.rootLabel]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ action, line: props.paneHeaderLine }), [action, props.paneHeaderLine]));
    return <View style={styles.root}><RepositoryTreeRootErrorState kind="unavailable" machineName={props.machineName} machineScope={props.machineScope} /></View>;
}

export type SessionRepositoryTreeBrowserViewProps = Readonly<{
    sessionId: string;
    serverId?: string | null;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned?: (fullPath: string) => void;
    density?: 'panel' | 'screen' | 'modal';
    searchQuery?: string;
    onSearchQueryChange?: (value: string) => void;
    showSearchBar?: boolean;
    onRequestClose?: () => void;
    revealRequest?: Readonly<{ path: string }>;
    selectedPath?: string | null;
}>;

/** Session is an authorization/navigation adapter, not a second filesystem browser. */
export const SessionRepositoryTreeBrowserView = React.memo((props: SessionRepositoryTreeBrowserViewProps) => {
    const { theme } = useUnistyles();
    const { machineRpcTargetAvailable } = useSessionMachineReachability(props.sessionId, props.serverId);
    const target = useSessionWorkspaceTarget(props.sessionId, props.serverId);
    const scope = React.useMemo(() => target ? { serverId: target.serverId, machineId: target.machineId, rootPath: target.rootPath } : null,
        [target?.serverId, target?.machineId, target?.rootPath]);
    const inferredServerId = useSessionServerId(props.sessionId, !scope && !props.serverId);
    const serverId = scope?.serverId ?? props.serverId ?? inferredServerId;
    const displayIdentity = useSessionMachineDisplayIdentity(scope ? '' : props.sessionId, serverId);
    // Attribution explains the wait; only the target owner may enable filesystem effects.
    const displayMachineScope = React.useMemo(() => serverId && displayIdentity.machineId && displayIdentity.basePath
        ? { serverId, machineId: displayIdentity.machineId } : null,
        [serverId, displayIdentity.machineId, displayIdentity.basePath]);
    const expandedPaths = useSessionRepositoryTreeExpandedPaths(props.sessionId);
    const setExpandedPaths = React.useCallback((paths: string[]) => storage.getState().setSessionRepositoryTreeExpandedPaths(props.sessionId, paths), [props.sessionId]);
    const withoutFolder = useSessionDirectoryKind(props.sessionId, serverId) === 'managed';
    const rootLabel = withoutFolder ? t('session.folderless.sessionFiles') : t('files.projectRoot');
    const scmSnapshot = useSessionProjectScmSnapshot(props.sessionId, serverId);
    const machineName = useSessionMachineName(props.sessionId, serverId);
    const uploadAvailable = useSessionFileUploadAvailability(props.sessionId, serverId);
    const refreshScm = React.useCallback(() => scmStatusSync.invalidateFromUser(props.sessionId, serverId), [props.sessionId, serverId]);
    React.useEffect(() => {
        if (scope && machineRpcTargetAvailable) refreshScm();
    }, [scope, machineRpcTargetAvailable, refreshScm]);
    const fileHref = React.useCallback((path: string) => hrefForDestinationRef([], {
        kind: 'sessionDetails', params: { id: props.sessionId, ...(serverId ? { serverId } : {}),
            ...serializeSessionPaneUrlState({ details: { kind: 'file', path } }) },
    }), [props.sessionId, serverId]);
    // The pane header's live line: where this Session works ("folder on machine"), then how many files changed (the Git pane's words).
    const rootPath = scope?.rootPath ?? (displayIdentity.basePath || null);
    const repoChangedCount = React.useMemo(() => scmSnapshot?.repo.isRepo ? selectScmChangedFiles(scmSnapshot).length : null, [scmSnapshot]);
    const paneHeaderLine = React.useMemo((): PaneHeaderLine | null => {
        const folder = withoutFolder ? null : leafFolderName(rootPath);
        const place = folder && machineName ? t('sessionGitPane.header.folderOnMachine', { folder, machine: machineName }) : folder ?? machineName;
        if (!place) return null;
        const segments: PaneHeaderLineSegment[] = [place];
        if (repoChangedCount !== null) {
            segments.push(repoChangedCount > 0
                ? t('sessionGitPane.header.changed', { count: formatExactCount(repoChangedCount) })
                : t('sessionGitPane.flow.header.noChanges'));
        }
        return { segments };
    }, [machineName, repoChangedCount, rootPath, withoutFolder]);
    // A changed file's row menu ends with Discard all changes in this file, the Session's own discard (lab FB1k).
    const scmWriteEnabled = useFeatureEnabled('scm.writeOperations');
    const commitStrategy = useSetting('scmCommitStrategy');
    const changedFiles = React.useMemo(() => scmSnapshot?.capabilities?.writeDiscard === true ? selectScmChangedFiles(scmSnapshot) : [],
        [scmSnapshot]);
    const buildFileMenuContext = React.useCallback((path: string): Partial<FileMenuContext> => {
        const file = scmWriteEnabled ? changedFiles.find(entry => entry.fullPath === path) : undefined;
        if (!file) return {};
        return { changes: { discardAll: () => applyFileDiscardAction({ sessionId: props.sessionId, serverId: serverId ?? undefined,
            sessionPath: rootPath, file, snapshot: scmSnapshot ?? null, scmWriteEnabled, commitStrategy, surface: 'files' }) } };
    }, [changedFiles, commitStrategy, props.sessionId, rootPath, scmSnapshot, scmWriteEnabled, serverId]);
    const scrollFades = useScrollEdgeFades({ enabledEdges: { top: true, bottom: true }, overflowThreshold: 1, edgeThreshold: 1 });
    const scrollProps = React.useMemo(() => ({ onLayout: scrollFades.onViewportLayout, onContentSizeChange: scrollFades.onContentSizeChange,
        onScroll: scrollFades.onScroll, scrollEventThrottle: 16 }), [scrollFades.onViewportLayout, scrollFades.onContentSizeChange, scrollFades.onScroll]);

    if (!scope) return <UnavailableSessionFiles rootLabel={rootLabel} machineName={machineName}
        machineScope={displayMachineScope} paneHeaderLine={paneHeaderLine} />;
    return (
        <WorkspaceRepositoryTreeBrowserView
            {...props}
            scope={scope}
            fileHref={fileHref}
            buildFileMenuContext={buildFileMenuContext}
            contextKey={props.sessionId}
            effectsEnabled={machineRpcTargetAvailable}
            transferEffectsEnabled={uploadAvailable}
            scmSnapshot={scmSnapshot}
            onRefreshScm={refreshScm}
            expandedPaths={expandedPaths}
            onExpandedPathsChange={setExpandedPaths}
            rootLabel={rootLabel}
            rootHeading={withoutFolder ? <SessionFilesRootHeading label={rootLabel} /> : null}
            machineName={machineName}
            createMenuPlacement="paneHeader"
            paneHeaderLine={paneHeaderLine}
            scrollProps={scrollProps}
            scrollOverlay={<><ScrollEdgeFades color={theme.colors.surface.base} size={18} edges={scrollFades.visibility} />
                <ScrollEdgeIndicators edges={scrollFades.visibility} color={theme.colors.text.secondary} size={14} opacity={0.35} /></>}
        />
    );
});
