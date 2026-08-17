import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createCapturingLegendListMock } from '@/dev/testkit/mocks/legendList';
import type { ServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A virtualized backend mounts a window of rows, not the whole data set. The
 * mock stands in for that window so the assertions below state the contract this
 * picker owns — "a long machine list does not mount one subscribing row per
 * machine" — rather than restating the virtualization threshold, which
 * `components/ui/selectionList/__tests__` already owns.
 */
const RENDERED_ROW_WINDOW = 8;
const MACHINE_COUNT = 80;

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
    renderItemLimit: RENDERED_ROW_WINDOW,
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

/**
 * The per-machine subtree whose mount count is the point of this suite: each
 * instance subscribes to its machine and to the daemon-scoped capabilities
 * cache. Stubbing it also cuts that sync/capabilities import graph.
 */
vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: ({ machineId }: { machineId: string }) =>
        React.createElement('MachineCliGlyphs', { testID: `machine-cli-glyphs:${machineId}` }),
}));

function createScopedMachine(index: number): ServerScopedMachine {
    const id = `m-${index}`;
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: {
            host: `${id}.local`,
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/tester/.happy',
            displayName: `Machine ${index}`,
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        serverId: 'server-a',
        serverName: 'Server A',
    };
}

describe('NewSessionMachineSelectionContent (long machine lists)', () => {
    it('windows a long machine list instead of mounting one row per machine', async () => {
        legendListState.reset();
        const machines = Array.from({ length: MACHINE_COUNT }, (_, index) => createScopedMachine(index));
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');

        const screen = await renderScreen(<NewSessionMachineSelectionContent
            groups={[{
                serverId: 'server-a',
                serverName: 'Server A',
                loading: false,
                signedOut: false,
                machines,
            }]}
            selectedMachine={machines[0]!}
            selectedServerId="server-a"
            recentMachines={[machines[0]!]}
            favoriteMachines={[machines[1]!]}
            onSelectMachine={() => {}}
            onSelectScopedMachine={() => {}}
            serverId="server-a"
            onToggleFavorite={() => {}}
            testIdPrefix="new-session-machine"
            showCliGlyphs
            autoDetectCliGlyphs={false}
        />);

        // The long section reaches the virtualized backend whole...
        expect(legendListState.props).not.toBeNull();
        expect(legendListState.props?.data?.length).toBeGreaterThanOrEqual(MACHINE_COUNT - 2);

        // ...and only its window is mounted. The pinned recent/favorite rows and
        // the hidden measure mirror are mounted too, so the bound is the window
        // rather than an exact count — what must not happen is one mounted row
        // per machine.
        const mountedRows = screen.findAllByType('MachineCliGlyphs');
        expect(mountedRows.length).toBeGreaterThan(0);
        expect(mountedRows.length).toBeLessThan(MACHINE_COUNT / 2);
    }, 240_000);
});
