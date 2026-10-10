import * as React from 'react';

/**
 * Header projection only: a mounted body lends the one quiet fact that names what it shows ("Tokens by
 * agent · last 30 days") to its nearest shared frame. The placement still decides precedence (a
 * followed group value wins), and the body never renders a second header.
 */
export const WidgetFrameBodyCaptionContext = React.createContext<
  ((caption: string | null) => void) | null
>(null);

export function useWidgetFrameBodyCaption(caption: string | null): void {
  const lend = React.useContext(WidgetFrameBodyCaptionContext);
  React.useEffect(() => {
    lend?.(caption);
    return () => lend?.(null);
  }, [caption, lend]);
}
