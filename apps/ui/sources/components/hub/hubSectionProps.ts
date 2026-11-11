import type { WidgetFrameProps, WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import type * as React from 'react';

/** The home's section menu (hide, move, customize); the Settings Overview passes none. */
export type HubSectionProps = Readonly<{
    menu?: React.ReactNode;
    /** A card section's frame (override, else Home's Appearance default), resolved by its slot. */
    frameStyle?: WidgetFrameStyle;
    /** A card's declared size where it landed on Home (`resolveHomeHubCardPresentation`), resolved by its slot. */
    widgetPresentation?: WidgetFrameProps['widgetPresentation'];
}>;
