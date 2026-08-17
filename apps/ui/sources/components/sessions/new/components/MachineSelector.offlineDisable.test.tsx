import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { MachineSelector } from './MachineSelector';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
    lastConfig: null as any,
    lastItems: null as any,
    lastRecentItems: null as any,
    lastFavoriteItems: null as any,
    lastGroupOrder: null as any,
    lastDropdownProps: null as any,
    reset() {
        this.lastConfig = null;
        this.lastItems = null;
        this.lastRecentItems = null;
        this.lastFavoriteItems = null;
        this.lastGroupOrder = null;
        this.lastDropdownProps = null;
    },
}));

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    textSecondary: '#666',
                    status: { connected: '#0f0', disconnected: '#f00' },
                    button: { primary: { background: '#00f' } },
                },
            },
            rt: { themeName: 'light' },
        });
    },
});

vi.mock('@/components/ui/forms/SearchableListSelector', () => ({
    SearchableListSelector: (props: any) => {
        captured.lastConfig = props?.config ?? null;
        captured.lastItems = props?.items ?? null;
        captured.lastRecentItems = props?.recentItems ?? null;
        captured.lastFavoriteItems = props?.favoriteItems ?? null;
        captured.lastGroupOrder = props?.groupOrder ?? null;
        return null;
    },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        captured.lastDropdownProps = props;
        return null;
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: () => null,
}));

describe('MachineSelector (disable offline)', () => {
    it('derives disabled predicate from online status when configured', async () => {
        captured.reset();

        const machines: any[] = [
            { id: 'm-online', active: true, activeAt: Date.now(), metadata: { displayName: 'Online' } },
            { id: 'm-offline', active: false, activeAt: 0, metadata: { displayName: 'Offline' } },
        ];

        await renderScreen(React.createElement(MachineSelector as any, {
                    machines,
                    selectedMachine: null,
                    onSelect: vi.fn(),
                    showCliGlyphs: false,
                    disableOfflineMachines: true,
                }));

        expect(captured.lastConfig).toBeTruthy();
        expect(typeof captured.lastConfig.isItemDisabled).toBe('function');
        expect(captured.lastConfig.isItemDisabled(machines[0])).toBe(false);
        expect(captured.lastConfig.isItemDisabled(machines[1])).toBe(true);
    });

    it('filters revoked machines out of the picker list', async () => {
        captured.reset();

        const machines: any[] = [
            { id: 'm-ok', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'OK' } },
            { id: 'm-revoked', active: false, activeAt: 0, revokedAt: Date.now(), metadata: { displayName: 'Revoked' } },
        ];

        await renderScreen(React.createElement(MachineSelector as any, {
                    machines,
                    selectedMachine: null,
                    onSelect: vi.fn(),
                    showCliGlyphs: false,
                }));

        expect(Array.isArray(captured.lastItems)).toBe(true);
        expect((captured.lastItems as any[]).map((m) => m.id)).toEqual(['m-ok']);
    });

    it('filters replaced machines out of all picker sections', async () => {
        captured.reset();

        const currentMachine: any = {
            id: 'm-current',
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: { displayName: 'Current' },
        };
        const replacedMachine: any = {
            id: 'm-replaced',
            active: false,
            activeAt: Date.now() - 1,
            revokedAt: null,
            replacedByMachineId: 'm-current',
            replacedAt: Date.now(),
            metadata: { displayName: 'Replaced' },
        };

        await renderScreen(React.createElement(MachineSelector as any, {
                    machines: [replacedMachine, currentMachine],
                    selectedMachine: null,
                    recentMachines: [replacedMachine],
                    favoriteMachines: [replacedMachine],
                    onSelect: vi.fn(),
                    showCliGlyphs: false,
                    showRecent: true,
                    showFavorites: true,
                }));

        expect((captured.lastItems as any[]).map((m) => m.id)).toEqual(['m-current']);
        expect((captured.lastRecentItems as any[]).map((m) => m.id)).toEqual([]);
        expect((captured.lastFavoriteItems as any[]).map((m) => m.id)).toEqual([]);
    });

    it('keeps the selected replaced machine visible as an unavailable option when requested', async () => {
        captured.reset();

        const currentMachine: any = {
            id: 'm-current',
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: { displayName: 'Current' },
        };
        const replacedMachine: any = {
            id: 'm-replaced',
            active: false,
            activeAt: Date.now() - 1,
            revokedAt: null,
            replacedByMachineId: 'm-current',
            replacedAt: Date.now(),
            metadata: { displayName: 'Replaced' },
        };

        await renderScreen(React.createElement(MachineSelector as any, {
            machines: [replacedMachine, currentMachine],
            selectedMachine: replacedMachine,
            onSelect: vi.fn(),
            showCliGlyphs: false,
            includeSelectedUnavailableMachine: true,
        }));

        expect((captured.lastItems as any[]).map((machine) => machine.id)).toEqual([
            'm-current',
            'm-replaced',
        ]);
        expect(captured.lastConfig.isItemDisabled(replacedMachine)).toBe(true);
    });

    it('omits recent and favorite machines from the all-section items to avoid duplicates', async () => {
        captured.reset();

        const machines: any[] = [
            { id: 'm-1', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'One' } },
            { id: 'm-2', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'Two' } },
        ];

        await renderScreen(React.createElement(MachineSelector as any, {
                    machines,
                    selectedMachine: null,
                    recentMachines: [machines[0]],
                    favoriteMachines: [machines[0]],
                    onSelect: vi.fn(),
                    showCliGlyphs: false,
                    showRecent: true,
                    showFavorites: true,
                }));

        expect((captured.lastRecentItems as any[]).map((m) => m.id)).toEqual([]);
        expect((captured.lastFavoriteItems as any[]).map((m) => m.id)).toEqual(['m-1']);
        expect((captured.lastItems as any[]).map((m) => m.id)).toEqual(['m-2']);
    });

    it('can render favorites before recent rows for wizard list presentation', async () => {
        captured.reset();

        const machine: any = { id: 'm-1', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'One' } };

        await renderScreen(React.createElement(MachineSelector as any, {
            machines: [machine],
            selectedMachine: machine,
            recentMachines: [machine],
            favoriteMachines: [machine],
            onSelect: vi.fn(),
            showCliGlyphs: false,
            favoriteGroupPlacement: 'beforeRecent',
        }));

        expect(captured.lastGroupOrder).toBe('favoritesFirst');
    });

    it('renders a dropdown trigger with the selected machine as subtitle', async () => {
        captured.reset();

        const machine: any = { id: 'm-1', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'One' } };

        await renderScreen(React.createElement(MachineSelector as any, {
            presentation: 'dropdown',
            machines: [machine],
            selectedMachine: machine,
            recentMachines: [machine],
            favoriteMachines: [],
            onSelect: vi.fn(),
            showCliGlyphs: false,
            dropdownTitle: 'Select Machine',
            dropdownTestID: 'machine-dropdown',
        }));

        expect(captured.lastDropdownProps?.itemTrigger).toMatchObject({
            title: 'Select Machine',
            subtitle: 'One',
            showSelectedDetail: false,
            showSelectedSubtitle: false,
        });
        expect(captured.lastDropdownProps?.itemTrigger?.itemProps).toMatchObject({
            testID: 'machine-dropdown',
        });
    });
});
