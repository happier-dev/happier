import { createContext, useContext, type ReactNode } from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';

export type WidgetPresentation = NonNullable<RenderContext['widgetPresentation']>;
export type WidgetPresentationProviderProps = Readonly<{
  value: WidgetPresentation | undefined;
  children?: ReactNode;
}>;
const WidgetPresentationContext = createContext<WidgetPresentation | undefined>(undefined);

/** Presentation facts supplied by the frame; changing them preserves the body's mounted lifetime. */
export function WidgetPresentationProvider(props: WidgetPresentationProviderProps) {
  return <WidgetPresentationContext.Provider value={props.value}>{props.children}</WidgetPresentationContext.Provider>;
}

/**
 * The body rows a size's footprint declares: two described list rows per grid row. A widget that lists rows
 * shows at most this many, so its last row ends whole at the card's foot; the page holds the rest.
 */
export function widgetFootprintBodyRows(footprint: Readonly<{ rowSpan: number }>): number {
  return footprint.rowSpan * 2;
}

/** Resolved size and actual body box, without adding data or execution authority. */
export function useWidgetPresentation(): WidgetPresentation | undefined {
  return useContext(WidgetPresentationContext);
}
