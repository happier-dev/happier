import { Image, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { FileVideoPreview } from './FileVideoPreview';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

type FileStateProps = {
    theme: any;
};

function getBasename(path: string): string {
    const parts = path.split(/[\\/]/);
    const last = parts.at(-1) ?? path;
    return last || path;
}

export function FileLoadingState({ filePath }: { filePath: string }) {
    return (
        <SurfaceStateCard
            testID="file-details-loading"
            kind="loading"
            title={t('surfaceState.opening', { name: getBasename(filePath) })}
        />
    );
}

/** A file that could not be read: what failed, the reason (already human copy), and one retry. */
export function FileErrorState({ filePath, error, onRetry }: { filePath: string; error?: string | null; onRetry: () => void }) {
    return (
        <SurfaceStateCard
            testID="file-details-error"
            kind="error"
            title={t('surfaceState.couldNotOpen', { name: getBasename(filePath) })}
            reason={error ?? undefined}
            detail={filePath}
            action={{ label: t('surfaceState.tryAgain'), onPress: onRetry }}
        />
    );
}

export function FileBinaryState({
    theme,
    filePath,
    imagePreviewUri,
    workspaceScope,
    videoMimeType,
    binaryPreviewRevision,
    isActive = true,
}: FileStateProps & {
    filePath: string;
    imagePreviewUri?: string | null;
    workspaceScope?: WorkspaceScopeBase | null;
    videoMimeType?: string | null;
    binaryPreviewRevision?: string | null;
    isActive?: boolean;
}) {
    if (workspaceScope && videoMimeType) {
        return <View style={{ padding: 20, alignItems: 'center' }}>
            <FileVideoPreview workspaceScope={workspaceScope} filePath={filePath} mimeType={videoMimeType}
                revision={binaryPreviewRevision} isActive={isActive} />
        </View>;
    }
    return (
        <View
            style={{
                flex: 1,
                backgroundColor: theme.colors.surface.base,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20,
            }}
        >
            {typeof imagePreviewUri === 'string' && imagePreviewUri.trim().length > 0 ? (
                <View
                    style={{
                        width: '100%',
                        maxWidth: 720,
                        height: 320,
                        borderRadius: 12,
                        overflow: 'hidden',
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
                        marginBottom: 14,
                    }}
                >
                    <Image
                        source={{ uri: imagePreviewUri }}
                        resizeMode="contain"
                        style={{ width: '100%', height: '100%' }}
                        accessibilityLabel={t('files.binaryFile')}
                    />
                </View>
            ) : null}
            <Text
                style={{
                    fontSize: 18,
                    color: theme.colors.text.secondary,
                    marginBottom: 8,
                    ...Typography.default('semiBold'),
                }}
            >
                {t('files.binaryFile')}
            </Text>
            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.text.secondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t('files.cannotDisplayBinary')}
            </Text>
            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.text.secondary,
                    textAlign: 'center',
                    marginTop: 8,
                    ...Typography.default(),
                }}
            >
                {filePath}
            </Text>
        </View>
    );
}
