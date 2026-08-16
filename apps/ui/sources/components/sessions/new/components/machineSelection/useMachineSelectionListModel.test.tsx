import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerScopedMachine, ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

import { installNewSessionComponentsCommonModuleMocks } from '../newSessionComponentsTestHelpers';
import type {
    BuildMachineSelectionListModelParams,
    useMachineSelectionListModel as UseMachineSelectionListModel,
} from './useMachineSelectionListModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

// Cuts the row-accessory's sync/ops import graph out of this pure-model suite;
// the accessory is only ever created as an element here, never rendered.
vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: () => null,
}));

let useMachineSelectionListModel: typeof UseMachineSelectionListModel;

beforeAll(async () => {
    ({ useMachineSelectionListModel } = await import('./useMachineSelectionListModel'));
}, 240_000);

function createMachine(id: string): Machine {
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
            displayName: id,
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function createScopedMachine(machine: Machine): ServerScopedMachine {
    return {
        ...machine,
        serverId: 'server-a',
        serverName: 'Server A',
    };
}

type Fixture = Readonly<{
    machines: ReadonlyArray<Machine>;
    groups: ReadonlyArray<ServerScopedMachineGroup>;
    recent: ReadonlyArray<Machine>;
    favorites: ReadonlyArray<Machine>;
}>;

/**
 * Built per test, never at module scope: `isMachineOnline` compares `activeAt`
 * against a 60s grace window, and this suite's module evaluation can precede
 * the first test by longer than that — a module-scope fixture would silently
 * decay to "offline" and make every row non-selectable.
 */
function createFixture(): Fixture {
    const machines = ['m-1', 'm-2', 'm-3'].map(createMachine);
    return {
        machines,
        groups: [{
            serverId: 'server-a',
            serverName: 'Server A',
            loading: false,
            signedOut: false,
            machines: machines.map(createScopedMachine),
        }],
        recent: [machines[0]!],
        favorites: [machines[1]!],
    };
}

type Handlers = Readonly<{
    selectSpy: ReturnType<typeof vi.fn>;
    toggleSpy: ReturnType<typeof vi.fn>;
    onSelectMachine: (machine: Machine) => void;
    onSelectScopedMachine: (machine: ServerScopedMachine) => void;
    onToggleFavorite: (machine: Machine) => void;
}>;

/**
 * Every field except the handlers is referentially stable across renders — the
 * new-session screen model stabilizes groups / recent / favorites by signature
 * (`useStableValueBySignature`). Only the handlers are recreated, exactly like
 * the machine popover's `renderContent({ requestClose, maxHeight })` does on
 * every measured-placement pass while the popover is open.
 */
function buildParams(fixture: Fixture, handlers: Handlers): BuildMachineSelectionListModelParams {
    return {
        groups: fixture.groups,
        selectedMachine: fixture.machines[0]!,
        selectedServerId: 'server-a',
        recentMachines: fixture.recent,
        favoriteMachines: fixture.favorites,
        onSelectMachine: handlers.onSelectMachine,
        onSelectScopedMachine: handlers.onSelectScopedMachine,
        serverId: 'server-a',
        onToggleFavorite: handlers.onToggleFavorite,
        showFavorites: true,
        showRecent: true,
        showSearch: true,
        showCliGlyphs: true,
        autoDetectCliGlyphs: true,
        favoriteGroupPlacement: 'afterRecent',
        testIdPrefix: 'new-session-machine',
    };
}

function makeHandlers(): Handlers {
    const selectSpy = vi.fn();
    const toggleSpy = vi.fn();
    return {
        selectSpy,
        toggleSpy,
        onSelectMachine: (machine) => selectSpy(machine.id),
        onSelectScopedMachine: (machine) => selectSpy(machine.id),
        onToggleFavorite: (machine) => toggleSpy(machine.id),
    };
}

async function renderModel(fixture: Fixture, initialProps: Handlers) {
    return renderHook<ReturnType<typeof UseMachineSelectionListModel>, Handlers>(
        (handlers) => useMachineSelectionListModel(buildParams(fixture, handlers)),
        { initialProps },
    );
}

function firstStaticOption(model: ReturnType<typeof UseMachineSelectionListModel>) {
    const section = model.rootStep.sections[0];
    if (section?.kind !== 'static') throw new Error('expected a leading static section');
    const option = section.options[0];
    if (!option) throw new Error('expected at least one option');
    return option;
}

describe('useMachineSelectionListModel', () => {
    it('reuses the derived model when only the caller handler identities change', async () => {
        const rendered = await renderModel(createFixture(), makeHandlers());
        const first = rendered.getCurrent();

        await rendered.rerender(makeHandlers());
        const second = rendered.getCurrent();

        // Handlers are behaviour, not data: recreating them must not rebuild the
        // step tree, because every row's `icon` / `rightAccessory` element loses
        // referential identity when it does, and React can then no longer skip
        // the row subtrees while the popover re-renders.
        expect(second.rootStep).toBe(first.rootStep);
        expect(second.rootStep.sections).toBe(first.rootStep.sections);
        expect(firstStaticOption(second)).toBe(firstStaticOption(first));
        expect(firstStaticOption(second).rightAccessory).toBe(firstStaticOption(first).rightAccessory);

        await rendered.unmount();
    });

    it('rebuilds the model when the machine data actually changes', async () => {
        // Same handler identities, different data: the model MUST be rebuilt,
        // otherwise the ref indirection would freeze the list against real
        // machine/recent/favorite updates.
        const fixture = createFixture();
        const handlers = makeHandlers();
        const rendered = await renderHook<ReturnType<typeof UseMachineSelectionListModel>, ReadonlyArray<Machine>>(
            (recent) => useMachineSelectionListModel({ ...buildParams(fixture, handlers), recentMachines: recent }),
            { initialProps: fixture.recent },
        );
        const before = rendered.getCurrent().rootStep;
        expect(before.sections.map((section) => section.id)).toEqual(['recent', 'favorites', 'all']);

        await rendered.rerender([fixture.machines[2]!]);
        const after = rendered.getCurrent().rootStep;
        expect(after).not.toBe(before);
        const recentSection = after.sections[0];
        if (recentSection?.kind !== 'static') throw new Error('expected the recent section');
        expect(recentSection.options.map((option) => option.id)).toEqual(['m-3']);

        await rendered.unmount();
    });

    it('activates the LATEST handler after the caller replaced it', async () => {
        const initialHandlers = makeHandlers();
        const rendered = await renderModel(createFixture(), initialHandlers);

        const nextHandlers = makeHandlers();
        await rendered.rerender(nextHandlers);

        firstStaticOption(rendered.getCurrent()).onSelect?.();

        expect(nextHandlers.selectSpy).toHaveBeenCalledTimes(1);
        expect(initialHandlers.selectSpy).not.toHaveBeenCalled();

        await rendered.unmount();
    });
});
