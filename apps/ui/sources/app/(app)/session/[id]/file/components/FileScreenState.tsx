import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type FileStateProps = {
    theme: any;
};

export function FileLoadingState({ theme, fileName }: FileStateProps & { fileName: string }) {
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

export function FileErrorState({ theme, message }: FileStateProps & { message: string }) {
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
                {message}
            </Text>
        </View>
    );
}

export function FileBinaryState({ theme, fileName }: FileStateProps & { fileName: string }) {
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
                {fileName}
            </Text>
        </View>
    );
}
