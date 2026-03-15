import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';
import { SessionRightPanelGitView } from '@/components/sessions/panes/git/SessionRightPanelGitView';
import { t } from '@/text';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

export type SessionRightPanelProps = Readonly<{
    sessionId: string;
    scopeId: string;
}>;

type RightTabId = 'git' | 'files';

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
    segmented: {
        flexDirection: 'row',
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        overflow: 'hidden',
        flex: 1,
    },
    segment: {
        flex: 1,
        paddingVertical: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    segmentActive: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    segmentLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    segmentLabelActive: {
        color: theme.colors.text,
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

export const SessionRightPanel = React.memo((props: SessionRightPanelProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const scopeState = pane.scopeState;

    const activeTab = (scopeState?.right.activeTabId as RightTabId | null) ?? 'git';

    const setActiveTab = React.useCallback((tabId: RightTabId) => {
        pane.openRight({ tabId });
        pane.setRightTab(tabId);
    }, [pane]);

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

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <View style={styles.segmented}>
                    <Pressable
                        testID="session-rightpanel-tab-git"
                        onPress={() => setActiveTab('git')}
                        style={[styles.segment, activeTab === 'git' ? styles.segmentActive : null]}
                        accessibilityRole="button"
                    >
                        <Text style={[styles.segmentLabel, activeTab === 'git' ? styles.segmentLabelActive : null]}>
                            {t('settings.sourceControl')}
                        </Text>
                    </Pressable>
                    <Pressable
                        testID="session-rightpanel-tab-files"
                        onPress={() => setActiveTab('files')}
                        style={[styles.segment, activeTab === 'files' ? styles.segmentActive : null]}
                        accessibilityRole="button"
                    >
                        <Text style={[styles.segmentLabel, activeTab === 'files' ? styles.segmentLabelActive : null]}>
                            {t('common.files')}
                        </Text>
                    </Pressable>
                </View>
                <Pressable
                    testID="session-rightpanel-close"
                    onPress={pane.closeRight}
                    style={styles.closeButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                >
                    <Octicons name="x" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                    <RightTabSurface isActive={activeTab === 'git'}>
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.textSecondary} />}>
                            <SessionRightPanelGitView sessionId={props.sessionId} scopeId={props.scopeId} />
                        </React.Suspense>
                    </RightTabSurface>
                    <RightTabSurface isActive={activeTab === 'files'}>
                        <React.Suspense fallback={<PaneLoadingFallback color={theme.colors.textSecondary} />}>
                            <SessionRepositoryTreeBrowserView
                                sessionId={props.sessionId}
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

const RightTabSurface = React.memo((props: Readonly<{ isActive: boolean; children: React.ReactNode }>) => {
    const active = props.isActive;
    const [hasMounted, setHasMounted] = React.useState(active);

    React.useLayoutEffect(() => {
        if (active) setHasMounted(true);
    }, [active]);

    if (!active && !hasMounted) return null;
    return (
        <View
            style={[
                StyleSheet.absoluteFillObject,
                { opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' },
            ]}
        >
            {props.children}
        </View>
    );
});
