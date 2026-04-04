import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { WorkspaceRepositoryTreeBrowserView } from '@/components/projects/files/WorkspaceRepositoryTreeBrowserView';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { WorkspaceRightPanelGitView } from '@/components/projects/scm/WorkspaceRightPanelGitView';
import { resolveProjectRightTabId, type ProjectRightTabId } from './resolveProjectRightTabId';
import { buildProjectRouteHref } from './projectRouteState';
import { storage } from '@/sync/domains/state/storage';
import { computeExpandedPathsForReveal } from '@/components/workspaces/files/repositoryTree/computeExpandedPathsForReveal';

export type ProjectRightPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    activeRootPath: string;
    onSelectRootPath: (path: string) => void;
    onRequestClose?: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        minHeight: 0,
        minWidth: 0,
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.divider,
    },
    header: {
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    segmentedContainer: {
        flex: 1,
    },
    closeButton: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    body: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
}));

export const ProjectRightPanel = React.memo((props: ProjectRightPanelProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const insets = useChromeSafeAreaInsets();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(props.scopeId);
    const scopeState = pane.scopeState;
    const headerPaddingTop = 10;

    const activeTab: ProjectRightTabId = resolveProjectRightTabId(scopeState?.right.activeTabId);

    const setActiveTab = React.useCallback((tabId: ProjectRightTabId) => {
        pane.openRight({ tabId });
        pane.setRightTab(tabId);
        if (deviceType !== 'phone') return;
        if (activeTab === tabId) return;
        router.replace(buildProjectRouteHref({
            workspaceRefId: props.workspaceRef.id,
            segment: tabId,
            activeRootPath: props.activeRootPath,
            defaultRootPath: props.workspaceRef.rootPath,
        }));
    }, [activeTab, deviceType, pane, props.activeRootPath, props.workspaceRef.id, props.workspaceRef.rootPath, router]);

    React.useEffect(() => {
        if (!scopeState?.right.isOpen) return;
        if (!scopeState.right.activeTabId) {
            pane.setRightTab('git');
        }
    }, [pane, scopeState?.right.activeTabId, scopeState?.right.isOpen]);

    const openFileInDetails = React.useCallback((fullPath: string) => {
        const fileName = fullPath.split('/').pop() ?? fullPath;
        deferOnWeb(() => {
            pane.openDetailsTab({
                key: `file:${fullPath}`,
                kind: 'file',
                title: fileName,
                resource: { kind: 'file', path: fullPath },
            });
        });
    }, [pane]);

    const openFileInDetailsPinned = React.useCallback((fullPath: string) => {
        const fileName = fullPath.split('/').pop() ?? fullPath;
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: `file:${fullPath}`,
                    kind: 'file',
                    title: fileName,
                    resource: { kind: 'file', path: fullPath },
                },
                { intent: 'pinned' },
            );
        });
    }, [pane]);

    const openReviewAllChanges = React.useCallback(() => {
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: 'scmReview:working',
                    kind: 'scmReview',
                    title: t('files.toolbar.review'),
                    resource: { kind: 'scmReview', scope: 'working' },
                },
                { intent: 'pinned' },
            );
        });
    }, [pane]);

    const openStashDetails = React.useCallback(() => {
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: 'scmStash',
                    kind: 'scmStash',
                    title: t('files.stash.detailsTitle'),
                    resource: { kind: 'scmStash' },
                },
                { intent: 'pinned' },
            );
        });
    }, [pane]);

    const openCreateWorktreeFlow = React.useCallback(() => {
        router.push({
            pathname: '/new',
            params: {
                machineId: props.workspaceRef.machineId,
                directory: props.activeRootPath,
                worktree: 'new',
            },
        });
    }, [props.activeRootPath, props.workspaceRef.machineId, router]);

    const openCommitInDetails = React.useCallback((sha: string) => {
        const safeSha = sha.trim().split(/\s+/)[0] ?? '';
        if (!safeSha) return;
        deferOnWeb(() => {
            pane.openDetailsTab({
                key: `commit:${safeSha}`,
                kind: 'commit',
                title: safeSha.slice(0, 7),
                resource: { kind: 'commit', sha: safeSha },
            });
        });
    }, [pane]);

    const revealInFilesTree = React.useCallback((fullPath: string) => {
        setActiveTab('files');
        const scope = {
            serverId: props.workspaceRef.serverId,
            machineId: props.workspaceRef.machineId,
            rootPath: props.activeRootPath,
        };
        const currentExpandedPaths = storage.getState().getWorkspaceRepositoryTreeExpandedPaths(scope);
        const nextExpandedPaths = computeExpandedPathsForReveal({
            expandedPaths: currentExpandedPaths,
            fullPath,
        });
        storage.getState().setWorkspaceRepositoryTreeExpandedPaths(scope, nextExpandedPaths);
    }, [props.activeRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId, setActiveTab]);

    const rightPanelTabs = React.useMemo((): ReadonlyArray<SegmentedTab<ProjectRightTabId>> => ([
        { id: 'git', label: t('settings.sourceControl') },
        { id: 'files', label: t('common.files') },
    ]), []);

    const workspaceCacheKey = React.useMemo(() => buildWorkspaceCacheKey({
        serverId: props.workspaceRef.serverId,
        machineId: props.workspaceRef.machineId,
        rootPath: props.activeRootPath,
    }), [props.activeRootPath, props.workspaceRef.machineId, props.workspaceRef.serverId]);

    return (
        <View testID="project-right-panel-root" style={styles.container}>
            <View style={[styles.header, { paddingTop: headerPaddingTop + insets.top }]}>
                <View style={styles.segmentedContainer}>
                    <SegmentedTabBar
                        tabs={rightPanelTabs}
                        activeTabId={activeTab}
                        onSelectTab={setActiveTab}
                        testIDPrefix="project-rightpanel-tab"
                    />
                </View>
                {props.onRequestClose && deviceType !== 'phone' ? (
                    <Pressable
                        testID="project-rightpanel-close"
                        onPress={props.onRequestClose}
                        style={styles.closeButton}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                    >
                        <Octicons name="x" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                ) : null}
            </View>
            <View style={styles.body}>
                <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                    <RightTabSurface isActive={activeTab === 'git'} testID="project-rightpanel-surface-git">
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.textSecondary} />}>
                            <WorkspaceRightPanelGitView
                                serverId={props.workspaceRef.serverId}
                                machineId={props.workspaceRef.machineId}
                                rootPath={props.activeRootPath}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                                onOpenReviewAllChanges={openReviewAllChanges}
                                onOpenStashDetails={openStashDetails}
                                onOpenCommit={openCommitInDetails}
                                onSelectWorkspacePath={props.onSelectRootPath}
                                onRequestCreateWorktreeFromAnotherBranch={openCreateWorktreeFlow}
                                onRevealInFilesTree={revealInFilesTree}
                            />
                        </React.Suspense>
                    </RightTabSurface>
                    <RightTabSurface isActive={activeTab === 'files'} testID="project-rightpanel-surface-files">
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.textSecondary} />}>
                            <WorkspaceRepositoryTreeBrowserView
                                workspaceCacheKey={workspaceCacheKey}
                                serverId={props.workspaceRef.serverId}
                                machineId={props.workspaceRef.machineId}
                                rootPath={props.activeRootPath}
                                onOpenFile={openFileInDetails}
                                onOpenFilePinned={openFileInDetailsPinned}
                                density="panel"
                            />
                        </React.Suspense>
                    </RightTabSurface>
                </View>
            </View>
        </View>
    );
});

const PaneLoadingFallback = React.memo((props: Readonly<{ color: string }>) => {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingHorizontal: 16 }}>
            <ActivityIndicator size="small" color={props.color} />
            <Text style={{ marginTop: 10, fontSize: 12, color: props.color, ...Typography.default() }}>
                {t('common.loading')}
            </Text>
        </View>
    );
});

const RightTabSurface = React.memo((props: Readonly<{ isActive: boolean; testID?: string; children: React.ReactNode }>) => {
    const active = props.isActive;
    const [hasMounted, setHasMounted] = React.useState(active);

    React.useLayoutEffect(() => {
        if (active) setHasMounted(true);
    }, [active]);

    if (!active && !hasMounted) return null;
    return (
        <View
            testID={props.testID}
            pointerEvents={active ? 'auto' : 'none'}
            style={[
                { flex: 1, minHeight: 0, minWidth: 0 },
                !active ? { display: 'none' } : null,
            ]}
        >
            {props.children}
        </View>
    );
});
