import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useBrandPaneTokens } from './brandPaneTokens';

const TRUST_CLAIM_SEPARATOR = ' · ';
/** The box each claim's " · " stands in, before the claim. */
const MOBILE_SEPARATOR_WIDTH_PX = 16;
// Every claim carries its separator before it, and the row starts one separator box to the left under a clip:
// a separator that would open a line is never seen, so no line starts or ends on "·" (as the pane header's facts).
const MOBILE_CLIP = { overflow: 'hidden' } as const;
const MOBILE_WRAP = { flexDirection: 'row', flexWrap: 'wrap', marginLeft: -MOBILE_SEPARATOR_WIDTH_PX } as const;
const MOBILE_CLAIM = { flexDirection: 'row' } as const;
const MOBILE_SEPARATOR = { width: MOBILE_SEPARATOR_WIDTH_PX, textAlign: 'center' } as const;

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
    if (props.mobile) {
        // On a phone it wraps between its claims, never inside one ("SELF-" / "HOSTABLE").
        const claims = t('welcome.brandTrustStrip').split(TRUST_CLAIM_SEPARATOR);
        return (
            <View testID="brand-trust-strip" style={MOBILE_CLIP}>
                <View style={MOBILE_WRAP}>
                    {claims.map((claim) => (
                        <View key={claim} style={MOBILE_CLAIM}>
                            <Text style={[style, MOBILE_SEPARATOR]} accessibilityElementsHidden importantForAccessibility="no">·</Text>
                            <Text style={style} numberOfLines={1}>{claim}</Text>
                        </View>
                    ))}
                </View>
            </View>
        );
    }
    return (
        <Text testID="brand-trust-strip" style={style} numberOfLines={1}>
            {t('welcome.brandTrustStrip')}
        </Text>
    );
});
