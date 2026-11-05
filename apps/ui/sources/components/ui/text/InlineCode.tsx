import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierInlineCode, type HappierInlineCodeTextProps } from '@happier-dev/plugin-ui/presentation';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';

/** Core's text owner, so the chip follows the user's font scale. */
function InlineCodeText(props: HappierInlineCodeTextProps) {
    return <Text testID={props.testID} style={props.style as StyleProp<TextStyle>}>{props.children}</Text>;
}

/**
 * Happier core's binding of the shared inline code chip (`@happier-dev/plugin-ui/presentation`, the same
 * owner plugin surfaces draw with): it supplies only core's text owner, mono face, inks and the
 * density-aware `s4` inset.
 */
export const InlineCode = React.memo((props: Readonly<{ children: React.ReactNode; style?: StyleProp<TextStyle>; testID?: string }>) => {
    const { theme } = useUnistyles();
    return (
        <HappierInlineCode
            Text={InlineCodeText}
            testID={props.testID}
            fontFamily={Typography.mono().fontFamily}
            ink={theme.colors.text.primary}
            fill={theme.colors.surface.elevated}
            paddingHorizontalPx={theme.space.s4}
            {...(props.style === undefined ? {} : { style: props.style as HappierInlineCodeTextProps['style'] })}
        >
            {props.children}
        </HappierInlineCode>
    );
});
