import * as React from 'react';
import { createSplitCanvasPersistenceSnapshot } from '../model/splitCanvasPersistence';
import type {
    SplitCanvasPersistenceSnapshot,
    SplitCanvasState,
} from '../model/splitCanvasTypes';

export function useSplitCanvasPersistence<TLeafPayload>(input: Readonly<{
    state: SplitCanvasState<TLeafPayload>;
    onPersist: (snapshot: SplitCanvasPersistenceSnapshot<TLeafPayload>) => void;
    enabled?: boolean;
}>): SplitCanvasPersistenceSnapshot<TLeafPayload> {
    const snapshot = React.useMemo(() => createSplitCanvasPersistenceSnapshot(input.state), [input.state]);

    React.useEffect(() => {
        if (input.enabled === false) return;
        input.onPersist(snapshot);
    }, [input, snapshot]);

    return snapshot;
}
