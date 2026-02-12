import * as React from 'react';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';

export function ChangedFilesSectionHeader(props: {
    theme: any;
    color: string;
    children: React.ReactNode;
}): React.ReactElement {
    const { theme, color, children } = props;
    return (
        <View
            style={{
                backgroundColor: theme.colors.surfaceHigh,
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
            }}
        >
            <Text
                style={{
                    fontSize: 14,
                    color,
                    ...Typography.default('semiBold'),
                }}
            >
                {children}
            </Text>
        </View>
    );
}

