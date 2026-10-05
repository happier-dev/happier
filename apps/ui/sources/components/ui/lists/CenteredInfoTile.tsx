import { HAPPIER_STATE_SIZE_METRICS, HappierInfoTile, type HappierStateSize } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

type CenteredInfoTileProps = Readonly<{
    icon?: React.ReactNode;
    title: string;
    /** Optional glyph decoration within the existing title typography. */
    titleContent?: React.ReactNode;
    description: React.ReactNode;
    titleTestID?: string;
    descriptionTestID?: string;
    paddingHorizontal?: number;
    paddingVertical?: number;
    /** The container's size step (pane, details, page, phone): measure, glyph gap and type. */
    size?: HappierStateSize;
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
    const metrics = props.size ? HAPPIER_STATE_SIZE_METRICS[props.size] : null;

    return (
        <HappierInfoTile
            // The glyph stands alone above the title, with room to breathe rather than touching it.
            icon={props.icon ? <View style={{ marginBottom: metrics?.glyphGapPx ?? 12 }}>{props.icon}</View> : undefined}
            paddingHorizontal={props.paddingHorizontal}
            paddingVertical={props.paddingVertical}
            size={props.size}
            title={
                <Text
                    testID={props.titleTestID}
                    style={{
                        fontSize: metrics?.title.fontSize ?? 18,
                        ...(metrics ? { lineHeight: metrics.title.lineHeight } : null),
                        ...Typography.default('semiBold'),
                        color: theme.colors.text.primary,
                        textAlign: 'center',
                        marginBottom: metrics?.bodyGapPx ?? 6,
                    }}
                >
                    {props.titleContent ?? props.title}
                </Text>
            }
            description={
                <Text
                    testID={props.descriptionTestID}
                    style={{
                        fontSize: metrics?.body.fontSize ?? 14,
                        ...Typography.default(),
                        color: theme.colors.text.secondary,
                        textAlign: 'center',
                        lineHeight: metrics?.body.lineHeight ?? 20,
                    }}
                >
                    {props.description}
                </Text>
            }
        />
    );
});

CenteredInfoTile.displayName = 'CenteredInfoTile';
