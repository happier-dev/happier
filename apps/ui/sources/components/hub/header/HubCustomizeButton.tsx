import * as React from 'react';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';

/**
 * "Customize" in Home's header: it puts the page itself into Customize and takes it back out (lab
 * `widget-groups` wgmenu E). Nothing opens over the page; the bar under the greeting
 * (`HomeCustomizeBar`) and the groups' own bars are where the editing happens. A section's
 * "⋯ → Customize" enters the same state, so the state belongs to Home.
 */
export const HubCustomizeButton = React.memo(function HubCustomizeButton(props: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
}>) {
    const { onOpenChange } = props;
    const toggle = React.useCallback(() => onOpenChange(!props.open), [onOpenChange, props.open]);
    // A phone's header has no room beside the greeting for a labelled button: the glyph alone (I1p).
    const compact = !useIsTablet();
    return compact ? (
        <IconButton
            testID="home-hub.customize"
            variant="plain"
            iconName="sliders-horizontal"
            accessibilityLabel={t('homeIndex.customizeTitle')}
            selected={props.open}
            expanded={props.open}
            onPress={toggle}
        />
    ) : (
        <SectionActionButton
            testID="home-hub.customize"
            title={t('homeIndex.customize')}
            icon="sliders-horizontal"
            expanded={props.open}
            onPress={toggle}
        />
    );
});
