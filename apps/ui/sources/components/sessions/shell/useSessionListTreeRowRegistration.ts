import * as React from 'react';
import type { View } from 'react-native';

import type {
    RegisterSessionListTreeRowBounds,
    UnregisterSessionListTreeRowBounds,
} from './SessionListHeaderFrame';

/** Keep measurement refs current when virtualization reuses a same-sized view. */
export function useSessionListTreeRowRegistration(
    rowId: string,
    register: RegisterSessionListTreeRowBounds,
    unregister: UnregisterSessionListTreeRowBounds,
) {
    const wrapperRef = React.useRef<View | null>(null);
    const setWrapperRef = React.useCallback((node: View | null) => {
        wrapperRef.current = node;
        // onLayout alone misses identity changes in recycled cells: web's
        // ResizeObserver does not fire when the host view keeps its size.
        if (node) register(rowId, node);
        else unregister(rowId);
    }, [register, rowId, unregister]);
    const handleLayout = React.useCallback(() => {
        if (wrapperRef.current) register(rowId, wrapperRef.current);
    }, [register, rowId]);
    return { wrapperRef, setWrapperRef, handleLayout };
}
