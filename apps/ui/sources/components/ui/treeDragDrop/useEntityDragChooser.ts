import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntityDragCarry, EntityDragDropRuntime, EntityDropDestination } from './entityDragDropTypes';
import { useEntityDragDestinations, useEntityDragSourceState } from './entityDragDropHooks';

/** Keep one staged carry through async admission and selection; dismiss never dispatches it. */
export function useEntityDragChooser(runtime: EntityDragDropRuntime, sourceId: string, onApplied?: () => void) {
    const [open, setOpen] = useState(false);
    const state = useEntityDragSourceState(runtime, sourceId);
    const destinations = useEntityDragDestinations(runtime, sourceId, open && state.phase === 'carrying');
    const carry = useRef<EntityDragCarry | null>(null);
    const applied = useRef(onApplied); applied.current = onApplied;
    const onOpenChange = useCallback((value: boolean) => {
        if (value) {
            const snapshot = runtime.getSnapshot();
            if (!carry.current || snapshot.sourceId !== sourceId || snapshot.phase !== 'carrying') carry.current = runtime.begin(sourceId, 'keyboard');
            setOpen(carry.current !== null);
        } else {
            setOpen(false);
            carry.current?.cancel('chooser-dismissed'); carry.current = null;
        }
    }, [runtime, sourceId]);
    useEffect(() => () => { carry.current?.cancel('chooser-unmounted'); carry.current = null; }, [runtime, sourceId]);
    const select = useCallback(async (destination: EntityDropDestination | undefined) => {
        const active = carry.current;
        if (!destination || !active || destination.admission.status !== 'allowed') return null;
        carry.current = null;
        active.choose(destination.targetId, destination.destination);
        setOpen(false);
        const outcome = await active.release();
        if (outcome?.status === 'applied') applied.current?.();
        return outcome;
    }, []);
    const onMenuKeyDown = useCallback((event: Readonly<{ key?: string; shiftKey?: boolean; nativeEvent?: { key?: string; shiftKey?: boolean }; preventDefault?: () => void; stopPropagation?: () => void }>) => {
        const key = event.key ?? event.nativeEvent?.key;
        if (key !== 'ContextMenu' && !(key === 'F10' && (event.shiftKey ?? event.nativeEvent?.shiftKey))) return false;
        event.preventDefault?.(); event.stopPropagation?.();
        onOpenChange(true);
        return true;
    }, [onOpenChange]);
    return { open: open && state.phase === 'carrying', destinations, onOpenChange, select, onMenuKeyDown };
}
