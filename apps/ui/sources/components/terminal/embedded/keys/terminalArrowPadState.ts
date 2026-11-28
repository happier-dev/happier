import { useEffect, useMemo } from 'react';
import { z } from 'zod/mini';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { ArrowPadPlacement } from './terminalArrowPadGeometry';

type Orientation = 'portrait' | 'landscape';

const tuckedState = createPersistentUiState('terminal-arrow-pad-tucked-v1', value => z.boolean().parse(value));
const layoutSchema = z.nullable(z.object({ side: z.enum(['left', 'right']), y: z.number() }));
const placementState = createPersistentUiState('terminal-arrow-pad-placement-v1', value => layoutSchema.safeParse(value).data);

function readLegacyPlacement(orientation: Orientation): ArrowPadPlacement | null {
    return getStorage().getState().localSettings.terminalArrowPadPlacement?.[orientation] ?? null;
}

function layoutOf(placement: ArrowPadPlacement | null) {
    return placement && { side: placement.side, y: placement.y };
}

export function useTerminalArrowPadPlacement(orientation: Orientation): ArrowPadPlacement | null {
    const placement = usePersistentUiStateValue(placementState, orientation);
    const tucked = usePersistentUiStateValue(tuckedState, orientation);
    // Seed only the orientation currently in use. A keyed null records an explicit reset.
    const legacy = useMemo(() => placementState.read(orientation) === undefined || tuckedState.read(orientation) === undefined
        ? readLegacyPlacement(orientation) : null, [orientation]);
    useEffect(() => {
        try {
            if (placementState.read(orientation) === undefined) placementState.set(orientation, layoutOf(legacy));
            if (tuckedState.read(orientation) === undefined) tuckedState.set(orientation, legacy?.tucked ?? false);
        } catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            console.warn('[terminal] Arrow pad placement could not be migrated.');
        }
    }, [legacy, orientation]);
    const layout = placement === undefined ? layoutOf(legacy) : placement;
    return layout ? { ...layout, tucked: tucked ?? legacy?.tucked ?? false } : null;
}

/** Both the live pad and the phone specimen commit through the same keyed state. */
export function writeTerminalArrowPadPlacement(orientation: Orientation, placement: ArrowPadPlacement | null): void {
    try {
        placementState.set(orientation, layoutOf(placement));
        tuckedState.set(orientation, placement?.tucked ?? false);
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[terminal] Arrow pad placement could not be persisted.');
    }
}
