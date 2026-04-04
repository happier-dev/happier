import * as React from 'react';
import { ActivityIndicator, Image, Platform, Pressable, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { decodeBase64 } from '@/encryption/base64';

type FileStateProps = {
    theme: any;
};

function getBasename(path: string): string {
    const parts = path.split('/');
    const last = parts.at(-1) ?? path;
    return last || path;
}

export function FileLoadingState({ theme, filePath }: FileStateProps & { filePath: string }) {
    const fileName = getBasename(filePath);
    return (
        <View
            style={{
                flex: 1,
                backgroundColor: theme.colors.surface,
                justifyContent: 'center',
                alignItems: 'center',
            }}
        >
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            <Text
                style={{
                    marginTop: 16,
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {t('files.loadingFile', { fileName })}
            </Text>
        </View>
    );
}

export function FileErrorState({ theme, filePath, error, onRetry }: FileStateProps & { filePath: string; error: string; onRetry: () => void }) {
    return (
        <View
            style={{
                flex: 1,
                backgroundColor: theme.colors.surface,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20,
            }}
        >
            <Text
                style={{
                    fontSize: 18,
                    color: theme.colors.textDestructive,
                    marginBottom: 8,
                    ...Typography.default('semiBold'),
                }}
            >
                {t('common.error')}
            </Text>
            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {error}
            </Text>
            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    marginTop: 8,
                    ...Typography.default(),
                }}
            >
                {filePath}
            </Text>
            <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                style={{
                    marginTop: 16,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
                }}
            >
                <Text style={{ fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') }}>
                    {t('common.retry')}
                </Text>
            </Pressable>
        </View>
    );
}

export function FileBinaryState({ theme, filePath, imagePreviewUri }: FileStateProps & { filePath: string; imagePreviewUri?: string | null }) {
    const svgXml = React.useMemo(() => {
        if (Platform.OS === 'web') return null;
        if (typeof imagePreviewUri !== 'string') return null;
        if (!imagePreviewUri.startsWith('data:image/svg+xml')) return null;
        const base64Index = imagePreviewUri.indexOf('base64,');
        if (base64Index < 0) return null;
        const base64 = imagePreviewUri.slice(base64Index + 'base64,'.length);
        if (!base64) return null;
        try {
            const bytes = decodeBase64(base64, 'base64');
            const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            return decoded.includes('<svg') ? decoded : null;
        } catch {
            return null;
        }
    }, [imagePreviewUri]);

    return (
        <View
            style={{
                flex: 1,
                backgroundColor: theme.colors.surface,
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
                        borderColor: theme.colors.divider,
                        backgroundColor: theme.colors.surfaceHigh ?? theme.colors.surface,
                        marginBottom: 14,
                    }}
                >
                    {svgXml ? (
                        <SvgXml xml={svgXml} width="100%" height="100%" />
                    ) : (
                        <Image
                            source={{ uri: imagePreviewUri }}
                            resizeMode="contain"
                            style={{ width: '100%', height: '100%' }}
                            accessibilityLabel={t('files.binaryFile')}
                        />
                    )}
                </View>
            ) : null}
            <Text
                style={{
                    fontSize: 18,
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...Typography.default('semiBold'),
                }}
            >
                {t('files.binaryFile')}
            </Text>
            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t('files.cannotDisplayBinary')}
            </Text>
            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
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
