import * as React from 'react';

/** Factual placement and binding observations; the page's Resource owner decides admission. */
export type WidgetFrameDemand = Readonly<{
    place(id: string, builtinId: string | undefined, visible: boolean | null): () => void;
    refuse(id: string, refused: boolean): () => void;
}>;
export const WidgetFrameDemandContext = React.createContext<WidgetFrameDemand | null>(null);
export const WidgetFrameInstanceIdContext = React.createContext<string | null>(null);
