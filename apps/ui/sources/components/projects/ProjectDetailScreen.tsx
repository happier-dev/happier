import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { resolveProjectRightTabId } from './detail/resolveProjectRightTabId';
import { useWorkspaceRefById } from './detail/useWorkspaceRefById';
import { ProjectRightPanel } from './detail/ProjectRightPanel';
import { ProjectDetailsMainPanel } from './detail/ProjectDetailsMainPanel';

export const ProjectDetailScreen = React.memo((props: Readonly<{
    workspaceRefId: string;
    activeRootPath?: string | null;
    onSelectRootPath?: (path: string) => void;
}>) => {
    const { theme } = useUnistyles();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const lastActiveRootPathByWorkspaceRefId = useLocalSetting('projectLastActiveRootPathByWorkspaceRefId');
    const [, setLastActiveRootPathByWorkspaceRefId] = useLocalSettingMutable('projectLastActiveRootPathByWorkspaceRefId');
    const scopeId = React.useMemo(() => buildProjectPaneScopeId(props.workspaceRefId), [props.workspaceRefId]);
    const pane = useAppPaneScope(scopeId);
    const workspaceRef = useWorkspaceRefById(props.workspaceRefId);
    const [localActiveRootPath, setLocalActiveRootPath] = React.useState<string | null>(null);
    const controlledActiveRootPath = props.activeRootPath ?? null;
    const persistedActiveRootPath = React.useMemo(() => {
        if (!workspaceRef) return null;
        const value = lastActiveRootPathByWorkspaceRefId?.[workspaceRef.id];
        return typeof value === 'string' && value.trim().length > 0 ? value : null;
    }, [lastActiveRootPathByWorkspaceRefId, workspaceRef]);

    React.useEffect(() => {
        if (!workspaceRef) return;
        if (controlledActiveRootPath != null) return;
        setLocalActiveRootPath((currentPath) => {
            if (currentPath == null) {
                return persistedActiveRootPath ?? workspaceRef.rootPath;
            }
            if (
                persistedActiveRootPath
                && currentPath === workspaceRef.rootPath
                && persistedActiveRootPath !== workspaceRef.rootPath
            ) {
                return persistedActiveRootPath;
            }
            return currentPath;
        });
    }, [controlledActiveRootPath, persistedActiveRootPath, workspaceRef]);

    React.useEffect(() => {
        if (!workspaceRef) return;
        if (!multiPaneEnabled) return;
        if (!(Platform.OS === 'web' || deviceType === 'tablet')) return;
        const right = pane.scopeState?.right ?? null;
        if (!right) return;
        if (right.isOpen === true) return;
        const preferredTab = resolveProjectRightTabId(right.activeTabId);
        pane.openRight({ tabId: preferredTab });
        pane.setRightTab(preferredTab);
    }, [deviceType, multiPaneEnabled, pane, workspaceRef]);

    if (!workspaceRef) {
        return (
            <ItemList>
                <ItemGroup>
                    <View style={{ alignItems: 'center', paddingVertical: 32, paddingHorizontal: 16 }}>
                        <Ionicons
                            name="warning-outline"
                            size={48}
                            color={theme.colors.textSecondary}
                            style={{ marginBottom: 12 }}
                        />
                        <View style={{ maxWidth: 520 }}>
                            <Text style={{
                                fontSize: 16,
                                ...Typography.default('semiBold'),
                                color: theme.colors.text,
                                textAlign: 'center',
                                marginBottom: 6,
                            }}>
                                {t('projects.detail.notFoundTitle')}
                            </Text>
                            <Text style={{
                                fontSize: 14,
                                ...Typography.default(),
                                color: theme.colors.textSecondary,
                                textAlign: 'center',
                                lineHeight: 20,
                            }}>
                                {t('projects.detail.notFoundDescription')}
                            </Text>
                        </View>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    const resolvedActiveRootPath = controlledActiveRootPath ?? localActiveRootPath ?? persistedActiveRootPath ?? workspaceRef.rootPath;

    const handleSelectRootPath = React.useCallback((path: string) => {
        const trimmedPath = path.trim();
        if (!trimmedPath) return;
        if (controlledActiveRootPath == null) {
            setLocalActiveRootPath(trimmedPath);
        }
        setLastActiveRootPathByWorkspaceRefId({
            ...(lastActiveRootPathByWorkspaceRefId ?? {}),
            [props.workspaceRefId]: trimmedPath,
        });
        props.onSelectRootPath?.(trimmedPath);
    }, [controlledActiveRootPath, lastActiveRootPathByWorkspaceRefId, props, setLastActiveRootPathByWorkspaceRefId]);

    return (
        <AppPaneScopeHost
            scopeId={scopeId}
            detailsPaneEnabled={false}
            main={(
                <ProjectDetailsMainPanel
                    scopeId={scopeId}
                    workspaceRef={workspaceRef}
                    activeRootPath={resolvedActiveRootPath}
                    onSelectRootPath={handleSelectRootPath}
                />
            )}
            rightPane={(
                <ProjectRightPanel
                    scopeId={scopeId}
                    workspaceRef={workspaceRef}
                    activeRootPath={resolvedActiveRootPath}
                    onSelectRootPath={handleSelectRootPath}
                />
            )}
            detailsPane={null}
            bottomPane={null}
        />
    );
});
