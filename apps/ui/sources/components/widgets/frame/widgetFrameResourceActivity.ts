import * as React from 'react';
import type { PluginUiResourceEntry, PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';

// Header projection only: Resource stores remain the owners of pending work and cancellation.
export const WidgetFrameResourceActivityContext = React.createContext<((key: symbol, refreshing: boolean) => void) | null>(null);

/** Lend the actual body's Resource pending fact to its nearest shared frame, without another read. */
export function useWidgetFrameResourceActivity(refreshing: boolean): void {
    const report = React.useContext(WidgetFrameResourceActivityContext);
    const [key] = React.useState(() => Symbol('resource'));
    React.useEffect(() => {
        report?.(key, refreshing);
        return () => report?.(key, false);
    }, [key, refreshing, report]);
}

/** Native hooks lend their existing consumer subscription's fact; this facade adds no observer or demand. */
export function useWidgetFrameResourceStoreActivity(store: PluginUiResourceStore | undefined): PluginUiResourceStore | undefined {
    const report = React.useContext(WidgetFrameResourceActivityContext);
    return React.useMemo(() => {
        if (!store || !report) return store;
        const observed: PluginUiResourceStore = {
            getEntry(resource) {
                const entry = store.getEntry(resource);
                const reported: PluginUiResourceEntry = {
                    ...entry,
                    subscribe(listener, live) {
                        const key = Symbol('native-resource');
                        let subscribed = true;
                        const publish = () => {
                            if (!subscribed) return;
                            report(key, entry.getSnapshot().pending === 'refresh');
                            listener();
                        };
                        const release = entry.subscribe(publish, live);
                        report(key, entry.getSnapshot().pending === 'refresh');
                        return () => {
                            subscribed = false;
                            release();
                            report(key, false);
                        };
                    },
                };
                return Object.freeze(reported);
            },
            dispose: () => store.dispose(),
        };
        return Object.freeze(observed);
    }, [report, store]);
}
