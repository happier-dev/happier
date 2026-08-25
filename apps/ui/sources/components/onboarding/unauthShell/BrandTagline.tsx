import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useBrandPaneTokens } from './brandPaneTokens';

export type BrandTaglineProps = Readonly<{
    /** Apply tighter sizing for the mobile brand hero variant. */
    mobile?: boolean;
}>;

/**
 * Two-line display tagline on the unauth brand pane:
 *   "Start coding anywhere."
 *   "Continue everywhere."
 *
 * Line 1 uses the full brand-pane foreground; line 2 uses the muted variant.
 * Both colors flip with the user's theme via `useBrandPaneTokens()` so the
 * tagline reads clearly against both the dark and the light planet variants.
 */
export const BrandTagline = React.memo(function BrandTagline(props: BrandTaglineProps) {
    const tokens = useBrandPaneTokens();
    const baseSize = props.mobile ? 44 : 48;
    const baseTracking = props.mobile ? -1.6 : -1.8;
    const baseStyle = {
        ...Typography.default('semiBold'),
        fontSize: baseSize,
        lineHeight: baseSize,
        letterSpacing: baseTracking,
    } as const;
    return (
        <View testID="brand-tagline" accessibilityRole="header">
            <Text style={[baseStyle, { color: tokens.foreground }]}>
                {t('welcome.brandTaglineLine1')}
            </Text>
            <Text style={[baseStyle, { color: tokens.foregroundMuted }]}>
                {t('welcome.brandTaglineLine2')}
            </Text>
        </View>
    );
});
