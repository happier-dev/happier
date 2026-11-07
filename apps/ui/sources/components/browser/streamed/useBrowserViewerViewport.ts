import * as React from 'react';

export type BrowserViewerViewport = Readonly<{ width: number; height: number; deviceScaleFactor: number }>;

/** Layout is the producer. Frame arrivals and unrelated renders never publish geometry. */
export function useBrowserViewerViewport(input: Readonly<{
    controlling: boolean;
    viewport: BrowserViewerViewport | null;
    sendViewport(viewport: BrowserViewerViewport): void;
}>): void {
    const send = React.useRef(input.sendViewport);
    send.current = input.sendViewport;
    const width = input.viewport?.width;
    const height = input.viewport?.height;
    const deviceScaleFactor = input.viewport?.deviceScaleFactor;
    React.useEffect(() => {
        if (input.controlling && width !== undefined && height !== undefined && deviceScaleFactor !== undefined) {
            send.current({ width, height, deviceScaleFactor });
        }
    }, [input.controlling, width, height, deviceScaleFactor]);
}
