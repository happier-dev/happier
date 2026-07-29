import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { useWorkspaceFileTransfers } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

function normalizeWorkspaceScope(scope: WorkspaceScopeBase | null): WorkspaceScopeBase | null {
    if (!scope) return null;
    const serverId = String(scope.serverId ?? '').trim();
    const machineId = String(scope.machineId ?? '').trim();
    const rootPath = String(scope.rootPath ?? '').trim();
    if (!serverId || !machineId || !rootPath) return null;
    return { serverId, machineId, rootPath };
}

export const WorkspaceFileDownloadButton = React.memo((props: Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    path: string;
    asZip?: boolean;
    testID?: string;
}>) => {
    const { theme } = useUnistyles();
    const normalizedScope = React.useMemo(() => normalizeWorkspaceScope(props.workspaceScope), [props.workspaceScope]);

    const transfers = useWorkspaceFileTransfers({
        workspaceScope: normalizedScope,
    });

    const busy = transfers.downloadState.status === 'downloading';
    const disabled = busy || !normalizedScope;

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={t('files.repositoryTree.actions.download')}
            disabled={disabled}
            onPress={(event) => {
                event?.stopPropagation?.();
                void (async () => {
                    if (!normalizedScope) return;
                    const res = await transfers.startDownload({ path: props.path, asZip: props.asZip === true });
                    if (!res.ok && res.canceled !== true) {
                        try {
                            const { Modal } = await import('@/modal');
                            Modal.alert(t('common.error'), res.error);
                        } catch {
                            // Best-effort only.
                        }
                    }
                })();
            }}
            style={({ pressed }) => ({
                width: 28,
                height: 28,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.55 : pressed ? 0.78 : 1,
            })}
        >
            {busy ? (
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            ) : (
                <Ionicons name="download-outline" size={14} color={theme.colors.text.secondary} />
            )}
        </Pressable>
    );
});
