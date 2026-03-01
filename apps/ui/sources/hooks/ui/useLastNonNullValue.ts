import * as React from 'react';

export function useLastNonNullValue<T>(
    value: T | null | undefined,
    opts?: Readonly<{ resetKey?: string | number | null }>
): T | null {
    const resetKey = opts?.resetKey ?? null;
    const lastValueRef = React.useRef<T | null>(null);
    const lastResetKeyRef = React.useRef<string | number | null>(resetKey);

    if (lastResetKeyRef.current !== resetKey) {
        lastResetKeyRef.current = resetKey;
        lastValueRef.current = null;
    }

    if (value !== null && value !== undefined) {
        lastValueRef.current = value;
    }

    return lastValueRef.current;
}
