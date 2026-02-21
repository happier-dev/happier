import * as React from 'react';
import { Platform, View } from 'react-native';

import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

type FileHeaderProps = {
    theme: any;
    fileName: string;
    filePathDir: string;
};

export function FileHeader({ theme, fileName, filePathDir }: FileHeaderProps) {
    const pathLabel = filePathDir || fileName;

    return (
        <View
            style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHigh,
                flexDirection: 'row',
                alignItems: 'center',
            }}
        >
            <FileIcon fileName={fileName} size={20} />
            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    marginLeft: 8,
                    flex: 1,
                    ...Typography.mono(),
                }}
            >
                {pathLabel}
            </Text>
        </View>
    );
}
