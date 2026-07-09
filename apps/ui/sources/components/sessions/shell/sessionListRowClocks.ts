import * as React from 'react';

const SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS = 60_000;

export function useSessionListRelativeNowMs(enabled = true): number {
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    const wasEnabledRef = React.useRef(enabled);
    React.useEffect(() => {
        if (!enabled) {
            wasEnabledRef.current = false;
            return undefined;
        }
        if (!wasEnabledRef.current) {
            setNowMs(Date.now());
        }
        wasEnabledRef.current = true;
        const intervalId = setInterval(() => {
            setNowMs(Date.now());
        }, SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS);
        return () => clearInterval(intervalId);
    }, [enabled]);
    return nowMs;
}
