import * as React from 'react';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useBrandPaneTokens } from './brandPaneTokens';

export type BrandTrustStripProps = Readonly<{
    /** Allow up to two lines on the mobile hero where width is tighter. */
    mobile?: boolean;
}>;

/**
 * Final caps-mono strip on the unauth brand pane:
 *   "END-TO-END ENCRYPTED · OPEN SOURCE · SELF-HOSTABLE"
 *
 * 11px mono with 0.08em tracking. The color uses the brand pane's muted
 * foreground so the strip flips with the user's theme.
 */
export const BrandTrustStrip = React.memo(function BrandTrustStrip(props: BrandTrustStripProps) {
    const tokens = useBrandPaneTokens();
    const style = {
        ...Typography.mono(),
        fontSize: 11,
        lineHeight: 16,
        letterSpacing: 0.88,
        color: tokens.foregroundMuted,
    } as const;
    return (
        <Text
            testID="brand-trust-strip"
            style={style}
            numberOfLines={props.mobile ? 2 : 1}
            adjustsFontSizeToFit={props.mobile}
        >
            {t('welcome.brandTrustStrip')}
        </Text>
    );
});
