import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';

installModalComponentCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('@/hooks/server/useDaemonScopedMachineCapabilitiesCache', () => ({
    useDaemonScopedMachineCapabilitiesCache: () => ({
        state: { status: 'idle' },
        refresh: () => {},
    }),
}));

vi.mock('@/components/machines/DetectedClisList', () => ({
    DetectedClisList: () => React.createElement('DetectedClisList'),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('DetectedClisModal', () => {
    it('uses fill card layout so the scroll body has measurable height on native', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { DetectedClisModal } = await import('./DetectedClisModal');
        const setChrome = vi.fn();

        await renderScreen(
            <DetectedClisModal
                machineId="machine-1"
                isOnline={true}
                onClose={() => {}}
                setChrome={setChrome}
            />,
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
                layout: 'fill',
            }),
        );
    });
});
