import * as React from 'react';
import { Platform, View } from 'react-native';

import { FileIcon } from '@/components/ui/media/FileIcon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

type FileHeaderProps = {
    theme: any;
    fileName: string;
    filePathDir: string;
    rightElement?: React.ReactNode;
};

export function FileHeader({ theme, fileName, filePathDir, rightElement }: FileHeaderProps) {
    const pathLabel = filePathDir || fileName;

    return (
        <View
            style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.inset,
                flexDirection: 'row',
                alignItems: 'center',
            }}
        >
            <FileIcon fileName={fileName} size={20} />
            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.text.secondary,
                    marginLeft: 8,
                    flex: 1,
                    ...Typography.mono(),
                }}
            >
                {pathLabel}
            </Text>
            {rightElement ? (
                <View testID="file-header-right" style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {rightElement}
                </View>
            ) : null}
        </View>
    );
}
