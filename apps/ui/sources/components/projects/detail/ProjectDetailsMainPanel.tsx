import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { WorkspaceDetailsPanel, type WorkspaceDetailsPanelHeaderActionRenderParams } from '@/components/projects/panes/WorkspaceDetailsPanel';

export type ProjectDetailsMainPanelProps = Readonly<{
    workspaceRef: WorkspaceRefV1;
    scopeId: string;
    onRequestClose?: () => void;
}>;

export const ProjectDetailsMainPanel = React.memo((props: ProjectDetailsMainPanelProps) => {
    const deviceType = useDeviceType();
    const router = useRouter();

    const renderHeaderActionsPrefix = React.useCallback((params: WorkspaceDetailsPanelHeaderActionRenderParams) => {
        if (deviceType !== 'phone') return null;
        const id = encodeURIComponent(props.workspaceRef.id);
        return (
            <>
                <Pressable
                    onPress={() => router.push(`/projects/${id}/git`)}
                    style={params.iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.sourceControl')}
                >
                    <Octicons name="git-branch" size={16} color={params.iconColor} />
                </Pressable>
                <Pressable
                    onPress={() => router.push(`/projects/${id}/files`)}
                    style={params.iconButtonStyle}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.files')}
                >
                    <Ionicons name="folder-outline" size={18} color={params.iconColor} />
                </Pressable>
            </>
        );
    }, [deviceType, props.workspaceRef.id, router]);

    return (
        <WorkspaceDetailsPanel
            workspaceRef={props.workspaceRef}
            scopeId={props.scopeId}
            onRequestClose={props.onRequestClose}
            renderHeaderActionsPrefix={renderHeaderActionsPrefix}
        />
    );
});
