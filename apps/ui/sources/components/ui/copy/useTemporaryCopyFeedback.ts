import * as React from 'react';

const DEFAULT_COPY_FEEDBACK_MS = 1200;

export function useTemporaryCopyFeedback(durationMs: number = DEFAULT_COPY_FEEDBACK_MS) {
    const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
    const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearCopiedFeedback = React.useCallback(() => {
        if (resetTimerRef.current) {
            clearTimeout(resetTimerRef.current);
            resetTimerRef.current = null;
        }
        setCopiedKey(null);
    }, []);

    const markCopied = React.useCallback((key: string = 'default') => {
        if (resetTimerRef.current) {
            clearTimeout(resetTimerRef.current);
            resetTimerRef.current = null;
        }
        setCopiedKey(key);
        resetTimerRef.current = setTimeout(() => {
            resetTimerRef.current = null;
            setCopiedKey(null);
        }, durationMs);
    }, [durationMs]);

    React.useEffect(() => clearCopiedFeedback, [clearCopiedFeedback]);

    return React.useMemo(() => ({
        copiedKey,
        clearCopiedFeedback,
        markCopied,
        isCopied: (key: string = 'default') => copiedKey === key,
    }), [clearCopiedFeedback, copiedKey, markCopied]);
}
