import * as React from 'react';
import { Platform } from 'react-native';

import { hapticsError, hapticsLight, hapticsSelection, hapticsSuccess } from '@/components/ui/theme/haptics';

import type { EntityDragDropRuntime, EntityDragDropSnapshot } from '../entityDragDropTypes';

/**
 * The physical feel of a carry, owned once per drag realm (DnD lab E1/K1h): on a phone the item
 * ticks when it lifts, when a new place would take it and when it lands or is refused; on the web the
 * pointer shows `grabbing` while an item rides it. It reads only the runtime's semantic verdict, never
 * pointer frames, so a carry still re-renders nothing.
 */
export function useEntityDragFeel(runtime: EntityDragDropRuntime): void {
    React.useEffect(() => {
        let previous: EntityDragDropSnapshot = runtime.getSnapshot();
        let restoreCursor: (() => void) | null = null;
        const setGrabbing = (grabbing: boolean) => {
            if (Platform.OS !== 'web' || typeof document === 'undefined') return;
            if (grabbing && !restoreCursor) {
                const body = document.body;
                const prior = body.style.cursor;
                body.style.cursor = 'grabbing';
                restoreCursor = () => { body.style.cursor = prior; };
            } else if (!grabbing && restoreCursor) {
                restoreCursor();
                restoreCursor = null;
            }
        };
        const onChange = () => {
            const next = runtime.getSnapshot();
            if (next === previous) return;
            const before = previous;
            previous = next;
            setGrabbing(next.phase === 'carrying' && runtime.getPointer() !== null);
            if (Platform.OS === 'web') return;
            if (next.phase === 'carrying' && before.phase !== 'carrying') void hapticsLight();
            else if (next.phase === 'carrying' && next.targetId !== before.targetId && next.admission?.status === 'allowed') void hapticsSelection();
            else if (next.phase === 'settled' && before.phase !== 'settled') {
                if (next.outcome?.status === 'applied') void hapticsSuccess();
                else if (next.outcome?.status === 'refused') void hapticsError();
            }
        };
        const unsubscribe = runtime.subscribe(onChange);
        // The cursor follows the pointer channel too: a keyboard carry never shows `grabbing`.
        const unsubscribePointer = Platform.OS === 'web'
            ? runtime.subscribePointer(() => setGrabbing(runtime.getSnapshot().phase === 'carrying' && runtime.getPointer() !== null))
            : () => {};
        return () => { unsubscribe(); unsubscribePointer(); setGrabbing(false); };
    }, [runtime]);
}
