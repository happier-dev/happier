import * as React from 'react';

import { type IconName } from '@/components/ui/icons/Icon';
import { ChromeGlyph } from '@/components/ui/icons/chromeGlyphInk';

import { APP_RAIL_ICON_GLYPH_SIZE_PX } from './appRailMetrics';

/**
 * The one rail glyph: every icon on the rail is this size in the same box, in the shell's chrome ink
 * (`useChromeGlyphInk`). The destination that is open draws filled; hover and focus only raise the ink.
 */
export const AppRailIcon = React.memo(function AppRailIcon(props: Readonly<{
    name: IconName;
    active?: boolean;
}>) {
    return (
        <ChromeGlyph
            name={props.name}
            size={APP_RAIL_ICON_GLYPH_SIZE_PX}
            weight={props.active ? 'fill' : 'regular'}
            active={props.active === true}
        />
    );
});
