import { describe, expect, it } from 'vitest';

import { createEmptyTerminalSurfaceState, replaceTerminalSurfaceState } from './terminalSurfaceStateCache';

describe('terminal surface renderer ownership', () => {
    it('releases a parsed renderer when its surface is replaced or evicted', () => {
        let replaced = false;
        let evicted = false;
        const resource = (release: () => void) => ({ kind: 'xterm-web' as const, attached: false,
            whenSettled: async () => {}, dispose: release });
        replaceTerminalSurfaceState('resource-replace', { ...createEmptyTerminalSurfaceState(),
            rendererResource: resource(() => { replaced = true; }) });
        replaceTerminalSurfaceState('resource-replace', createEmptyTerminalSurfaceState());
        expect(replaced).toBe(true);
        replaceTerminalSurfaceState('resource-evict', { ...createEmptyTerminalSurfaceState(),
            rendererResource: resource(() => { evicted = true; }) });
        for (let index = 0; index < 12; index += 1) {
            replaceTerminalSurfaceState(`resource-other-${index}`, createEmptyTerminalSurfaceState());
        }
        expect(evicted).toBe(true);
    });
});
