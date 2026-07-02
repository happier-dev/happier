import * as React from 'react';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useBrandPaneTokens } from './brandPaneTokens';

export type BrandSubTaglineProps = Readonly<{
    /** Drop the desktop max-width so the line stretches in a narrow phone hero. */
    mobile?: boolean;
}>;

/**
 * One-line description under the brand tagline. Uses the brand pane's soft
 * foreground (≈72% of the foreground) so it sits visually between the bold
 * tagline and the muted trust strip. Flips with theme via `useBrandPaneTokens`.
 */
export const BrandSubTagline = React.memo(function BrandSubTagline(props: BrandSubTaglineProps) {
    const tokens = useBrandPaneTokens();
    const style = {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: tokens.foregroundSoft,
        maxWidth: props.mobile ? undefined : 380,
    } as const;
    return (
        <Text testID="brand-sub-tagline" style={style}>
            {t('welcome.brandSubTagline')}
        </Text>
    );
});
