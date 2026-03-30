import * as React from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { useWorkspaceFileTransfers } from '@/hooks/session/files/useWorkspaceFileTransfers';

export const FileDownloadButton = React.memo((props: Readonly<{
    sessionId: string;
    path: string;
    asZip?: boolean;
    testID?: string;
}>) => {
    const { theme } = useUnistyles();

    const transfers = useWorkspaceFileTransfers({
        sessionId: props.sessionId,
    });

    const busy = transfers.downloadState.status === 'downloading';
    const disabled = busy;

    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={t('files.repositoryTree.actions.download')}
            disabled={disabled}
            onPress={(event) => {
                event?.stopPropagation?.();
                void (async () => {
                    const res = await transfers.startDownload({ path: props.path, asZip: props.asZip === true });
                    if (!res.ok) {
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
                borderColor: theme.colors.divider,
                backgroundColor: theme.colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.55 : pressed ? 0.78 : 1,
            })}
        >
            {busy ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : (
                <Ionicons name="download-outline" size={14} color={theme.colors.textSecondary} />
            )}
        </Pressable>
    );
});
