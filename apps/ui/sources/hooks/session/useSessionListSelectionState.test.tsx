import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const resolvedSelectionState = vi.hoisted(() => ({
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
        activeServerId: 'srv-a',
        allowedServerIds: ['srv-a', 'srv-b'],
        explicit: false,
    },
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => resolvedSelectionState.selection,
}));

describe('useSessionListSelectionState', () => {
    afterEach(() => {
        standardCleanup();
        resolvedSelectionState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a', 'srv-b'],
            explicit: false,
        };
    });

    it('returns the resolved active target together with the visible selection summary', async () => {
        const { useSessionListSelectionState } = await import('./useSessionListSelectionState');
        const hook = await renderHook(() => useSessionListSelectionState());

        expect(hook.getCurrent()).toEqual({
            enabled: true,
            presentation: 'grouped',
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a', 'srv-b'],
            selectedServerCount: 2,
        });
    });
});
