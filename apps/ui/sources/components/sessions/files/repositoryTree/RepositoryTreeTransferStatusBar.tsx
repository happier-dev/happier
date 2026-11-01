import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import type { WorkspaceDownloadState, WorkspaceUploadState } from '@/hooks/session/files/useWorkspaceFileTransfers';
import { Icon } from '@/components/ui/icons/Icon';

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
        gap: 10,
    },
    label: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    cancelButton: {
        width: 28,
        height: 28,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
}));

function resolveProgress(uploadedBytes: number, totalBytes: number): number {
    if (!Number.isFinite(uploadedBytes) || uploadedBytes <= 0) return 0;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
    return Math.max(0, Math.min(1, uploadedBytes / totalBytes));
}

function UploadRow(props: Readonly<{ state: Extract<WorkspaceUploadState, { status: 'preflighting' | 'uploading' }>; onCancel: () => void }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
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
                <Pressable
                    testID="repository-tree-upload-cancel"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                    onPress={props.onCancel}
                    style={styles.cancelButton}
                    hitSlop={10}
                >
                    <Icon name="x" size={16} color={theme.colors.text.secondary} />
                </Pressable>
            </View>
            {props.state.status === 'uploading' ? <MeterBar tone="neutral" height={4} animated fillFraction={progress} fillColor={theme.colors.text.link} progressAccessibilityLabel={label} /> : null}
        </View>
    );
}

function DownloadRow(props: Readonly<{ state: Extract<WorkspaceDownloadState, { status: 'downloading' }>; onCancel: () => void }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
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
                {props.state.cancelable !== false ? <Pressable
                    testID="repository-tree-download-cancel"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                    onPress={props.onCancel}
                    style={styles.cancelButton}
                    hitSlop={10}
                >
                    <Icon name="x" size={16} color={theme.colors.text.secondary} />
                </Pressable> : <View style={{ width: styles.cancelButton.width, height: styles.cancelButton.height }} />}
            </View>
            <MeterBar tone="neutral" height={4} animated fillFraction={progress} fillColor={theme.colors.text.link} progressAccessibilityLabel={label} />
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
