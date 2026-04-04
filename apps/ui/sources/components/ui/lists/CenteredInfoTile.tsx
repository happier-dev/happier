import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

type CenteredInfoTileProps = Readonly<{
    icon: React.ReactNode;
    title: string;
    description: React.ReactNode;
    titleTestID?: string;
    descriptionTestID?: string;
    paddingHorizontal?: number;
}>;

export const CenteredInfoTile = React.memo((props: CenteredInfoTileProps) => {
    const { theme } = useUnistyles();

    return (
        <View
            style={{
                width: '100%',
                alignItems: 'center',
                paddingVertical: 32,
                paddingHorizontal: props.paddingHorizontal ?? 16,
            }}
        >
            {props.icon}
            <View style={{ width: '100%', maxWidth: 520 }}>
                <Text
                    testID={props.titleTestID}
                    style={{
                        fontSize: 18,
                        ...Typography.default('semiBold'),
                        color: theme.colors.text,
                        textAlign: 'center',
                        marginBottom: 6,
                    }}
                >
                    {props.title}
                </Text>
                <Text
                    testID={props.descriptionTestID}
                    style={{
                        fontSize: 14,
                        ...Typography.default(),
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        lineHeight: 20,
                    }}
                >
                    {props.description}
                </Text>
            </View>
        </View>
    );
});
