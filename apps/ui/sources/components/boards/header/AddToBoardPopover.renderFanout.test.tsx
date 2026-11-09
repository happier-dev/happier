import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { RUN_STORAGE_PATH, boardRunStoragePage, installBoardLibraryTestHarness } from '../boardLibraryTestHarness';

const counts = vi.hoisted(() => ({ cells: 0 }));

const harness = installBoardLibraryTestHarness();
// Portal/window measurement is the boundary (as in AddToBoardPopover.test.tsx).
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, {
        maxHeight: 624, maxWidth: 960, placement: 'bottom',
    }));
// The recycler is the boundary: like Legend, a cell redraws only when its item or extraData changes.
vi.mock('@legendapp/list/react-native', async () => (await import('@/dev/testkit/mocks/legendList'))
    .createLegendListModuleMock({ renderItems: true, memoizeItems: true, onRenderItem: () => { counts.cells += 1; } }));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

const { SelectionList } = await import('@/components/ui/selectionList');
const { storage } = await import('@/sync/domains/state/storageStore');
const { AddToBoardButton, AddToBoardPopover } = await import('./AddToBoardPopover');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');

let serverId: string;
let previousStorage = storage.getState();

function Picker() {
    const anchorRef = React.useRef<View>(null);
    return <><AddToBoardButton anchorRef={anchorRef} open onOpenChange={() => {}} />
        <AddToBoardPopover
            anchorRef={anchorRef}
            homes={{ activeServerId: serverId, mountedServerIds: [serverId], isHomeMounted: (id) => id === serverId }}
            onBoardKeys={NO_KEYS}
            onAdd={() => {}}
            widgets={NO_WIDGETS}
            open
            onOpenChange={() => {}}
        /></>;
}
const NO_KEYS = new Set<string>();
const NO_WIDGETS = { scope: null, instances: [], addInstance: async () => ({ ok: true }) } as never;

beforeEach(async () => {
    previousStorage = storage.getState();
    serverId = await harness.connect('http://board-add-fanout.test');
    storage.setState({ profileScope: { serverId, accountId: 'account-a' } });
});

afterEach(async () => {
    standardCleanup();
    (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
    (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    await harness.dispose();
    storage.setState(previousStorage);
});

describe('AddToBoardPopover render fan-out', () => {
    it('redraws no row for a heartbeat and only the changed row for a Machine rename, a presence flip or a Session write', async () => {
        const now = Date.now();
        // Past the list's virtualization threshold, as on a busy Account (GAPS-B: 112 Machines).
        const machines = Array.from({ length: 60 }, (_, index) => createMachineFixture({
            id: `fanout-machine-${index}`, active: true, activeAt: now, updatedAt: now,
            metadata: { ...createMachineFixture().metadata!, displayName: `Machine ${index}`, host: `host-${index}` },
        }));
        const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const session = createSessionListRenderableSessionFixture({ id: 'fanout-session', metadata: { name: 'Fan-out session', path: '/repo', host: 'host' } });
        storage.setState({ machineListByServerId: { [serverId]: machines }, machineListStatusByServerId: { [serverId]: 'idle' },
            sessionListRowsByServerId: { [serverId]: { [session.id]: session } } });
        harness.answerDefinitions(serverId, { body: [] });
        harness.home.answer(serverId, RUN_STORAGE_PATH, { body: await boardRunStoragePage([]) });
        const screen = await renderScreen(<Picker />);
        try {
            const machineOptions = () => screen.findByType(SelectionList).props.rootStep.sections
                .find((section: Readonly<{ id: string }>) => section.id === 'machines')?.options ?? [];
            await waitForHomeGovernance(() => expect(machineOptions()).toHaveLength(60));
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

            // Liveness: a heartbeat that keeps every Machine online is not a content change.
            counts.cells = 0;
            const before = machineOptions();
            await act(async () => storage.getState().applyMachineActivityUpdates(
                machines.map(machine => ({ id: machine.id, active: true, activeAt: now + 1_000 })), { sourceServerId: serverId }));
            const heartbeat = { cells: counts.cells, sameOptions: machineOptions().every((option: unknown, index: number) => option === before[index]) };

            // One Machine renamed: one row changes.
            counts.cells = 0;
            await act(async () => storage.getState().applyMachines([{ ...machines[3]!,
                metadata: { ...machines[3]!.metadata!, displayName: 'Renamed 3' }, updatedAt: now + 2_000 }], false, { sourceServerId: serverId }));
            const renamed = { cells: counts.cells, label: machineOptions()[3]?.label };

            // A disconnect inside the online grace still reads Online: nothing to redraw.
            counts.cells = 0;
            await act(async () => storage.getState().applyMachineActivityUpdates(
                [{ id: machines[5]!.id, active: false, activeAt: now + 3_000 }], { sourceServerId: serverId }));
            const withinGrace = { cells: counts.cells, same: machineOptions()[5]?.subtitle === before[5]?.subtitle };

            // This Home's request to one Machine fails: only that Machine's presence line changes.
            counts.cells = 0;
            await act(async () => recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: machines[7]!.id }));
            const flipped = { cells: counts.cells, changed: machineOptions()[7]?.subtitle !== before[7]?.subtitle };

            // One Session renamed (an unrelated group): only its row changes.
            counts.cells = 0;
            await act(async () => storage.setState({ sessionListRowsByServerId: { [serverId]: {
                ...storage.getState().sessionListRowsByServerId[serverId],
                [session.id]: { ...session, metadata: { ...session.metadata!, name: 'Renamed session' } },
            } } }));
            const sessionWrite = { cells: counts.cells };

            expect({ heartbeat, renamed, withinGrace, flipped, sessionWrite }).toEqual({
                heartbeat: { cells: 0, sameOptions: true },
                withinGrace: { cells: 0, same: true },
                renamed: { cells: 1, label: 'Renamed 3' },
                flipped: { cells: 1, changed: true },
                sessionWrite: { cells: 1 },
            });
        } finally { await screen.unmount(); clearMachineRequestReachabilityForTest(); }
    });
});
