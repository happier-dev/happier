import { createContext, useContext, type ReactNode } from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';

export type WidgetPresentation = NonNullable<RenderContext['widgetPresentation']>;
const WidgetPresentationContext = createContext<WidgetPresentation | undefined>(undefined);

/** Presentation facts supplied by the frame; changing them preserves the body's mounted lifetime. */
export function WidgetPresentationProvider(props: Readonly<{ value: WidgetPresentation | undefined; children?: ReactNode }>) {
  return <WidgetPresentationContext.Provider value={props.value}>{props.children}</WidgetPresentationContext.Provider>;
}

/** Resolved size and actual body box, without adding data or execution authority. */
export function useWidgetPresentation(): WidgetPresentation | undefined {
  return useContext(WidgetPresentationContext);
}
