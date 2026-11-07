import { useEffect, useMemo } from 'react';
import { z } from 'zod/mini';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { ArrowPadPlacement } from './terminalArrowPadGeometry';

type Orientation = 'portrait' | 'landscape';

const tuckedState = createPersistentUiState('terminal-arrow-pad-tucked-v1', value => z.boolean().parse(value));

function writeTucked(orientation: Orientation, tucked: boolean): void {
    try { tuckedState.set(orientation, tucked); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[terminal] Arrow pad tucked state could not be persisted.');
    }
}

export function useTerminalArrowPadPlacement(orientation: Orientation): ArrowPadPlacement | null {
    const stored = useLocalSetting('terminalArrowPadPlacement');
    const tucked = usePersistentUiStateValue(tuckedState, orientation);
    // Read the retained Settings seed once when this orientation is first used, never at startup.
    const initialTucked = useMemo(() => tuckedState.read(orientation)
        ?? getStorage().getState().localSettings.terminalArrowPadPlacement?.[orientation]?.tucked
        ?? false, [orientation]);
    useEffect(() => {
        if (tuckedState.read(orientation) === undefined) writeTucked(orientation, initialTucked);
    }, [initialTucked, orientation]);
    const placement = stored?.[orientation];
    return placement ? { side: placement.side, y: placement.y, tucked: tucked ?? initialTucked } : null;
}

/** Both the live pad and the phone specimen commit through the same two state owners. */
export function writeTerminalArrowPadPlacement(orientation: Orientation, placement: ArrowPadPlacement | null): void {
    const state = getStorage().getState();
    const stored = state.localSettings.terminalArrowPadPlacement;
    const previous = stored?.[orientation] ?? null;
    // Restore/hide alone never enters the full Settings read/parse/merge path.
    const layoutChanged = placement === null ? previous !== null
        : placement.side !== previous?.side || placement.y !== previous?.y;
    if (layoutChanged) {
        state.applyLocalSettings({ terminalArrowPadPlacement: {
            portrait: stored?.portrait ?? null,
            landscape: stored?.landscape ?? null,
            [orientation]: placement ? {
                side: placement.side,
                y: placement.y,
                // Retain the old reader's required field without updating its interaction memory.
                tucked: previous?.tucked ?? false,
            } : null,
        } }, { source: 'ui' });
    }
    writeTucked(orientation, placement?.tucked ?? false);
}
