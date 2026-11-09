import * as React from 'react';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import type { WorkspaceDownloadState, WorkspaceUploadState } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import { Icon } from '@/components/ui/icons/Icon';
import { describeUploadFailure } from '@/components/transfers/describeUploadFailure';

const BAR_HEIGHT = 4;
const DOWNLOAD_CANCEL_BUTTON_SIZE = 28;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderTopColor: theme.colors.border.default,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        gap: theme.space.s10,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s20,
    },
    label: {
        flex: 1,
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
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
                uploaded: formatHappierDataBytes(props.state.uploadedBytes, { kind: 'storage' }),
                totalBytes: formatHappierDataBytes(props.state.totalBytes, { kind: 'storage' }),
            });

    const progress = resolveProgress(props.state.uploadedBytes, props.state.totalBytes);

    return (
        <View testID="repository-tree-upload-status" style={{ gap: theme.space.s8 }}>
            <View style={styles.row}>
                <Icon name="cloud-arrow-up" size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.label}>{label}</Text>
                <IconButton
                    testID="repository-tree-upload-cancel"
                    accessibilityLabel={t('common.cancel')}
                    iconName="x"
                    iconSize={16}
                    size={28}
                    interactiveTargetGapPx={20}
                    onPress={props.onCancel}
                />
            </View>
            {props.state.status === 'uploading' ? <MeterBar tone="neutral" height={BAR_HEIGHT} animated fillFraction={progress} fillColor={theme.colors.text.link} progressAccessibilityLabel={label} /> : null}
        </View>
    );
}

function DownloadRow(props: Readonly<{ state: Extract<WorkspaceDownloadState, { status: 'downloading' }>; onCancel: () => void }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const label = t('files.transfers.downloading', {
        name: props.state.name,
        downloaded: formatHappierDataBytes(props.state.downloadedBytes, { kind: 'storage' }),
        totalBytes: formatHappierDataBytes(props.state.totalBytes, { kind: 'storage' }),
    });
    const progress = resolveProgress(props.state.downloadedBytes, props.state.totalBytes);

    return (
        <View testID="repository-tree-download-status" style={{ gap: theme.space.s8 }}>
            <View style={styles.row}>
                <Icon name="download" size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.label}>{label}</Text>
                {props.state.cancelable !== false ? <IconButton
                    testID="repository-tree-download-cancel"
                    accessibilityLabel={t('common.cancel')}
                    iconName="x"
                    iconSize={16}
                    size={DOWNLOAD_CANCEL_BUTTON_SIZE}
                    interactiveTargetGapPx={20}
                    onPress={props.onCancel}
                /> : <View style={{
                    width: DOWNLOAD_CANCEL_BUTTON_SIZE,
                    height: DOWNLOAD_CANCEL_BUTTON_SIZE,
                }} />}
            </View>
            <MeterBar tone="neutral" height={BAR_HEIGHT} animated fillFraction={progress} fillColor={theme.colors.text.link} progressAccessibilityLabel={label} />
        </View>
    );
}

/**
 * A batch that ended in failure settles here, in words, and stays until dismissed: no dialog ever carries the
 * transport's own error text, and the line never says only that it failed. It says why: the Machine stopped
 * answering (by name), the person did not approve it, a permission refused it, it is too large, the result is
 * not known, or the Machine could not take it.
 */
function UploadFailureRow(props: Readonly<{ state: Extract<WorkspaceUploadState, { status: 'error' }>; machineName: string; onDismiss: () => void }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const label = describeUploadFailure(props.state.reason, props.machineName);
    return (
        <View testID="repository-tree-upload-failure" style={styles.row}>
            <Icon name={props.state.reason === 'unreachable' ? 'wifi-slash' : 'warning'} size={16} color={theme.colors.text.secondary} />
            <Text numberOfLines={2} style={styles.label}>{label}</Text>
            <IconButton
                testID="repository-tree-upload-failure-dismiss"
                accessibilityLabel={t('common.close')}
                iconName="x"
                iconSize={16}
                size={28}
                interactiveTargetGapPx={20}
                onPress={props.onDismiss}
            />
        </View>
    );
}

export function RepositoryTreeTransferStatusBar(props: Readonly<{
    uploadState: WorkspaceUploadState;
    downloadState: WorkspaceDownloadState;
    machineName: string;
    onCancelUploads: () => void;
    onDismissUploadFailure: () => void;
    onCancelDownload: () => void;
}>): React.ReactElement | null {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const showUpload = props.uploadState.status === 'preflighting' || props.uploadState.status === 'uploading';
    const failedUpload = props.uploadState.status === 'error' ? props.uploadState : null;
    const showDownload = props.downloadState.status === 'downloading';

    if (!showUpload && !failedUpload && !showDownload) return null;

    return (
        <View testID="repository-tree-transfer-status" style={[styles.container, { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            {failedUpload ? <UploadFailureRow state={failedUpload} machineName={props.machineName} onDismiss={props.onDismissUploadFailure} /> : null}
            {showUpload ? <UploadRow state={props.uploadState as any} onCancel={props.onCancelUploads} /> : null}
            {showDownload ? <DownloadRow state={props.downloadState as any} onCancel={props.onCancelDownload} /> : null}
        </View>
    );
}
