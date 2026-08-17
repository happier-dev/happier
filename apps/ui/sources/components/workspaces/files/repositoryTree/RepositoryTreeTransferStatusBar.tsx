import * as React from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import type { WorkspaceDownloadState, WorkspaceUploadState } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

const BAR_HEIGHT = 4;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 10,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 20,
    },
    label: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    progressTrack: {
        height: BAR_HEIGHT,
        borderRadius: 999,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    progressFill: {
        height: BAR_HEIGHT,
        borderRadius: 999,
        backgroundColor: theme.colors.text.link,
    },
}));

function resolveProgress(uploadedBytes: number, totalBytes: number): number {
    if (!Number.isFinite(uploadedBytes) || uploadedBytes <= 0) return 0;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
    return Math.max(0, Math.min(1, uploadedBytes / totalBytes));
}

function TransferProgressBar(props: Readonly<{ progress: number }>): React.ReactElement {
    const styles = stylesheet;
    const progress = Math.max(0, Math.min(1, props.progress));
    const anim = React.useRef(new Animated.Value(progress)).current;

    React.useEffect(() => {
        const useNativeDriver = Platform.OS !== 'web';
        Animated.timing(anim, {
            toValue: progress,
            duration: 160,
            easing: Easing.out(Easing.cubic),
            useNativeDriver,
        }).start();
    }, [anim, progress]);

    return (
        <View style={styles.progressTrack}>
            <Animated.View
                style={[
                    styles.progressFill,
                    {
                        width: anim.interpolate({
                            inputRange: [0, 1],
                            outputRange: ['0%', '100%'],
                        }),
                    },
                ]}
            />
        </View>
    );
}

function UploadRow(props: Readonly<{ state: Extract<WorkspaceUploadState, { status: 'preflighting' | 'uploading' }>; onCancel: () => void }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const totalFiles = props.state.totalFiles;
    const completedFiles = props.state.completedFiles;
    const label =
        props.state.status === 'preflighting'
            ? t('files.transfers.preparingUpload', { count: totalFiles })
            : t('files.transfers.uploading', {
                completed: completedFiles,
                total: totalFiles,
                uploaded: formatByteSize(props.state.uploadedBytes),
                totalBytes: formatByteSize(props.state.totalBytes),
            });

    const progress = resolveProgress(props.state.uploadedBytes, props.state.totalBytes);

    return (
        <View testID="repository-tree-upload-status" style={{ gap: 8 }}>
            <View style={styles.row}>
                <Icon name="cloud-arrow-up" size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.label}>{label}</Text>
                <IconButton
                    testID="repository-tree-upload-cancel"
                    accessibilityLabel={t('common.cancel')}
                    iconName="x"
                    iconSize={16}
                    size={28}
                    minimumInteractiveTargetSize={minimumInteractiveTargetSize}
                    interactiveTargetGapPx={20}
                    onPress={props.onCancel}
                />
            </View>
            {props.state.status === 'uploading' ? <TransferProgressBar progress={progress} /> : null}
        </View>
    );
}

function DownloadRow(props: Readonly<{ state: Extract<WorkspaceDownloadState, { status: 'downloading' }>; onCancel: () => void }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const label = t('files.transfers.downloading', {
        name: props.state.name,
        downloaded: formatByteSize(props.state.downloadedBytes),
        totalBytes: formatByteSize(props.state.totalBytes),
    });
    const progress = resolveProgress(props.state.downloadedBytes, props.state.totalBytes);

    return (
        <View testID="repository-tree-download-status" style={{ gap: 8 }}>
            <View style={styles.row}>
                <Icon name="download" size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.label}>{label}</Text>
                <IconButton
                    testID="repository-tree-download-cancel"
                    accessibilityLabel={t('common.cancel')}
                    iconName="x"
                    iconSize={16}
                    size={28}
                    minimumInteractiveTargetSize={minimumInteractiveTargetSize}
                    interactiveTargetGapPx={20}
                    onPress={props.onCancel}
                />
            </View>
            <TransferProgressBar progress={progress} />
        </View>
    );
}

export function RepositoryTreeTransferStatusBar(props: Readonly<{
    uploadState: WorkspaceUploadState;
    downloadState: WorkspaceDownloadState;
    onCancelUploads: () => void;
    onCancelDownload: () => void;
}>): React.ReactElement | null {
    const styles = stylesheet;
    const showUpload = props.uploadState.status === 'preflighting' || props.uploadState.status === 'uploading';
    const showDownload = props.downloadState.status === 'downloading';

    if (!showUpload && !showDownload) return null;

    return (
        <View testID="repository-tree-transfer-status" style={styles.container}>
            {showUpload ? <UploadRow state={props.uploadState as any} onCancel={props.onCancelUploads} /> : null}
            {showDownload ? <DownloadRow state={props.downloadState as any} onCancel={props.onCancelDownload} /> : null}
        </View>
    );
}
