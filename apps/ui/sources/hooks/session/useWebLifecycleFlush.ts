import * as React from 'react';

export type WebLifecycleFlushReason = 'documentHidden' | 'windowBlur' | 'pageHide' | 'pageFreeze';

type BrowserEventTarget = Readonly<{
    addEventListener?: (eventName: string, listener: () => void) => void;
    removeEventListener?: (eventName: string, listener: () => void) => void;
}>;

function addListener(
    target: BrowserEventTarget | null,
    eventName: string,
    listener: () => void,
): (() => void) {
    try {
        target?.addEventListener?.(eventName, listener);
    } catch {
        return () => {};
    }

    return () => {
        try {
            target?.removeEventListener?.(eventName, listener);
        } catch {
            // ignore lifecycle cleanup failures
        }
    };
}

export function useWebLifecycleFlush(
    enabled: boolean,
    flush: (reason: WebLifecycleFlushReason) => void,
) {
    const flushRef = React.useRef(flush);
    flushRef.current = flush;

    React.useEffect(() => {
        if (!enabled) return undefined;

        const doc = typeof document === 'undefined' ? null : document;
        const browserTarget = globalThis as BrowserEventTarget;
        const flushFor = (reason: WebLifecycleFlushReason) => {
            flushRef.current(reason);
        };
        const onVisibilityChange = () => {
            if (doc?.visibilityState === 'hidden') {
                flushFor('documentHidden');
            }
        };
        const disposers = [
            addListener(doc, 'visibilitychange', onVisibilityChange),
            addListener(browserTarget, 'blur', () => flushFor('windowBlur')),
            addListener(browserTarget, 'pagehide', () => flushFor('pageHide')),
            addListener(browserTarget, 'freeze', () => flushFor('pageFreeze')),
        ];

        return () => {
            for (const dispose of disposers) {
                dispose();
            }
        };
    }, [enabled]);
}
