import * as React from 'react';

import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropTypes';

import { resolvePaneDropStripCue, type PaneDropStripCue } from './paneDropPresentation';

const NO_CUE: PaneDropStripCue = Object.freeze({ slot: false, pulseTabKey: null });

/**
 * One tab strip's drop cue. It wakes only when the cue itself changes (a verdict entering or leaving
 * this strip's pane), never per pointer frame and never for another strip's verdict.
 */
export function usePaneDropStripCue(runtime: EntityDragDropRuntime | null | undefined, input: Readonly<{
    targetIds: readonly string[];
    tabIds: readonly string[];
}>): PaneDropStripCue {
    const latest = React.useRef(input);
    latest.current = input;
    const subscribe = React.useCallback((listener: () => void) => runtime?.subscribe(listener) ?? (() => {}), [runtime]);
    const read = React.useCallback(() => {
        if (!runtime) return '';
        const cue = resolvePaneDropStripCue(runtime.getSnapshot(), latest.current);
        return cue.slot ? 'slot' : cue.pulseTabKey !== null ? `ring:${cue.pulseTabKey}` : '';
    }, [runtime]);
    const key = React.useSyncExternalStore(subscribe, read, () => '');
    return React.useMemo(() => key === 'slot' ? { slot: true, pulseTabKey: null }
        : key.startsWith('ring:') ? { slot: false, pulseTabKey: key.slice('ring:'.length) } : NO_CUE, [key]);
}
