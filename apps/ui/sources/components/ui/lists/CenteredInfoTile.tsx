import { HappierInfoTile } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
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

/**
 * Happier core's centered-info-tile adapter.
 *
 * The layout — the full-width centered column, the 32/16 padding pair and the
 * 520pt readable measure — is the shared presentation owner (UI-T27), which the
 * plugin loading/empty/error states render too. This adapter supplies the one
 * thing core owns: its Unistyles typography, rendered through core's own `Text`
 * so the `uiFontScale` local setting still applies (§3.10.8).
 */
export const CenteredInfoTile = React.memo((props: CenteredInfoTileProps) => {
    const { theme } = useUnistyles();

    return (
        <HappierInfoTile
            icon={props.icon}
            paddingHorizontal={props.paddingHorizontal}
            title={
                <Text
                    testID={props.titleTestID}
                    style={{
                        fontSize: 18,
                        ...Typography.default('semiBold'),
                        color: theme.colors.text.primary,
                        textAlign: 'center',
                        marginBottom: 6,
                    }}
                >
                    {props.title}
                </Text>
            }
            description={
                <Text
                    testID={props.descriptionTestID}
                    style={{
                        fontSize: 14,
                        ...Typography.default(),
                        color: theme.colors.text.secondary,
                        textAlign: 'center',
                        lineHeight: 20,
                    }}
                >
                    {props.description}
                </Text>
            }
        />
    );
});

CenteredInfoTile.displayName = 'CenteredInfoTile';
