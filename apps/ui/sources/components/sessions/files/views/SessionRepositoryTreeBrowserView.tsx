import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { WorkspaceRepositoryTreeBrowserView } from '@/components/projects/files/WorkspaceRepositoryTreeBrowserView';
import { hrefForDestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionFileUploadAvailability } from '@/components/sessions/files/useSessionFileUploadAvailability';
import { storage, useSessionDirectoryKind, useSessionProjectScmSnapshot, useSessionRepositoryTreeExpandedPaths } from '@/sync/domains/state/storage';
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
import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { RepositoryTreeCreateMenu } from '@/components/workspaces/files/repositoryTree/RepositoryTreeCreateMenu';

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
            <Text numberOfLines={1} style={[Typography.rowTitle(), { color: theme.colors.text.primary }]}>{props.label}</Text>
        </View>
    );
}

const ignoreUnavailableAction = () => {};
function UnavailableSessionFiles(props: Readonly<{ rootLabel: string; machineName: string | null; onRetry: () => void }>) {
    const action = React.useMemo(() => <RepositoryTreeCreateMenu createEnabled={false} uploadEnabled={false} isWeb={Platform.OS === 'web'}
        uploadDestinationLabel={props.rootLabel} onSelect={ignoreUnavailableAction} />, [props.rootLabel]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ action }), [action]));
    return <View style={styles.root}><RepositoryTreeRootErrorState kind="unavailable" machineName={props.machineName} onRetry={props.onRetry} /></View>;
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
    const serverId = scope?.serverId ?? props.serverId;
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
    const scrollFades = useScrollEdgeFades({ enabledEdges: { top: true, bottom: true }, overflowThreshold: 1, edgeThreshold: 1 });
    const scrollProps = React.useMemo(() => ({ onLayout: scrollFades.onViewportLayout, onContentSizeChange: scrollFades.onContentSizeChange,
        onScroll: scrollFades.onScroll, scrollEventThrottle: 16 }), [scrollFades.onViewportLayout, scrollFades.onContentSizeChange, scrollFades.onScroll]);

    if (!scope) return <UnavailableSessionFiles rootLabel={rootLabel} machineName={machineName} onRetry={refreshScm} />;
    return (
        <WorkspaceRepositoryTreeBrowserView
            {...props}
            scope={scope}
            fileHref={fileHref}
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
            scrollProps={scrollProps}
            scrollOverlay={<><ScrollEdgeFades color={theme.colors.surface.base} size={18} edges={scrollFades.visibility} />
                <ScrollEdgeIndicators edges={scrollFades.visibility} color={theme.colors.text.secondary} size={14} opacity={0.35} /></>}
        />
    );
});
