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
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: () => null,
}));

describe('MachineSelector (disable offline)', () => {
    it('uses broad online presence for picker availability while exact readiness is unresolved', async () => {
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

    it('passes stable machine option and readiness test ids to the list selector', async () => {
        captured.reset();

        const machines: any[] = [
            { id: 'm-online', active: true, activeAt: Date.now(), metadata: { displayName: 'Online' } },
        ];

        await renderScreen(React.createElement(MachineSelector as any, {
            machines,
            selectedMachine: null,
            onSelect: vi.fn(),
            showCliGlyphs: false,
            disableOfflineMachines: true,
            testIdPrefix: 'new-session-machine',
        }));

        expect(captured.lastConfig).toBeTruthy();
        expect(captured.lastConfig.getItemStatusTestID(machines[0])).toBe('new-session-machine-readiness:m-online');
        expect(captured.lastConfig.getItemStatus(machines[0]).text).toBe('status.online');
        expect(captured.lastConfig.getItemStatus(machines[0]).state).toBe('ready');
        expect(captured.lastConfig.getItemStatus(machines[0]).testID).toBe('new-session-machine-readiness:m-online');
        expect(captured.lastConfig.isItemDisabled(machines[0])).toBe(false);
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

    it('filters replaced machines out of launch selection lists', async () => {
        captured.reset();

        const machines: any[] = [
            { id: 'm-current', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'Current' } },
            {
                id: 'm-replaced',
                active: false,
                activeAt: 0,
                revokedAt: null,
                replacedByMachineId: 'm-current',
                replacedAt: Date.now(),
                replacementReason: 'manual_repair',
                replacementSource: 'manual',
                metadata: { displayName: 'Replaced' },
            },
        ];

        await renderScreen(React.createElement(MachineSelector as any, {
            machines,
            selectedMachine: null,
            recentMachines: [machines[1]],
            favoriteMachines: [machines[1]],
            onSelect: vi.fn(),
            showCliGlyphs: false,
            showRecent: true,
            showFavorites: true,
        }));

        expect((captured.lastItems as any[]).map((m) => m.id)).toEqual(['m-current']);
        expect((captured.lastRecentItems as any[]).map((m) => m.id)).toEqual([]);
        expect((captured.lastFavoriteItems as any[]).map((m) => m.id)).toEqual([]);
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

    it('does not pin offline recent machines above online launchable machines', async () => {
        captured.reset();

        const offlineRecent: any = {
            id: 'm-offline-recent',
            active: false,
            activeAt: 0,
            revokedAt: null,
            metadata: { displayName: 'Offline Recent' },
        };
        const onlineMachine: any = {
            id: 'm-online',
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: { displayName: 'Online' },
        };

        await renderScreen(React.createElement(MachineSelector as any, {
            machines: [offlineRecent, onlineMachine],
            selectedMachine: null,
            recentMachines: [offlineRecent],
            favoriteMachines: [],
            onSelect: vi.fn(),
            showCliGlyphs: false,
            showRecent: true,
            showFavorites: true,
            disableOfflineMachines: true,
        }));

        expect((captured.lastRecentItems as any[]).map((m) => m.id)).toEqual([]);
        expect((captured.lastItems as any[]).map((m) => m.id)).toEqual(['m-online', 'm-offline-recent']);
    });

    it('can request favorites before recent machines without changing the default order', async () => {
        captured.reset();

        const machines: any[] = [
            { id: 'm-1', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'One' } },
        ];

        await renderScreen(React.createElement(MachineSelector as any, {
            machines,
            selectedMachine: null,
            recentMachines: machines,
            favoriteMachines: machines,
            onSelect: vi.fn(),
            showCliGlyphs: false,
            favoriteGroupPlacement: 'beforeRecent',
        }));

        expect(captured.lastGroupOrder).toBe('favoritesFirst');
    });

    it('renders a real dropdown instead of the list selector when dropdown presentation is requested', async () => {
        captured.reset();

        const machines: any[] = [
            { id: 'm-fav', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'Favorite' } },
            { id: 'm-recent', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'Recent' } },
            { id: 'm-other', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'Other' } },
        ];

        await renderScreen(React.createElement(MachineSelector as any, {
            presentation: 'dropdown',
            machines,
            selectedMachine: machines[1],
            recentMachines: [machines[1]],
            favoriteMachines: [machines[0]],
            onSelect: vi.fn(),
            onToggleFavorite: vi.fn(),
            showCliGlyphs: false,
            showRecent: true,
            showFavorites: true,
            favoriteGroupPlacement: 'beforeRecent',
            dropdownTestID: 'machine-dropdown-trigger',
            testIdPrefix: 'new-session-machine',
        }));

        expect(captured.lastItems).toBeNull();
        expect(captured.lastDropdownProps).toBeTruthy();
        expect(captured.lastDropdownProps.itemTrigger.itemProps.testID).toBe('machine-dropdown-trigger');
        expect(captured.lastDropdownProps.items.map((item: any) => [item.id, item.category])).toEqual([
            ['m-fav', 'newSession.machinePicker.favoritesTitle'],
            ['m-recent', 'newSession.machinePicker.recentTitle'],
            ['m-other', 'newSession.machinePicker.allTitle'],
        ]);
        expect(captured.lastDropdownProps.selectedId).toBe('m-recent');
        expect(captured.lastDropdownProps.items.map((item: any) => [item.id, item.testID])).toEqual([
            ['m-fav', 'new-session-machine-option:m-fav'],
            ['m-recent', 'new-session-machine-option:m-recent'],
            ['m-other', 'new-session-machine-option:m-other'],
        ]);
    });

    it('selects machines that are supplied through recent or favorite dropdown groups', async () => {
        captured.reset();

        const allMachine: any = { id: 'm-all', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'All' } };
        const recentMachine: any = { id: 'm-recent', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'Recent' } };
        const favoriteMachine: any = { id: 'm-favorite', active: true, activeAt: Date.now(), revokedAt: null, metadata: { displayName: 'Favorite' } };
        const onSelect = vi.fn();

        await renderScreen(React.createElement(MachineSelector as any, {
            presentation: 'dropdown',
            machines: [allMachine],
            selectedMachine: null,
            recentMachines: [recentMachine],
            favoriteMachines: [favoriteMachine],
            onSelect,
            showCliGlyphs: false,
            showRecent: true,
            showFavorites: true,
            favoriteGroupPlacement: 'beforeRecent',
        }));

        captured.lastDropdownProps.onSelect('m-recent');
        captured.lastDropdownProps.onSelect('m-favorite');

        expect(onSelect).toHaveBeenCalledWith(recentMachine);
        expect(onSelect).toHaveBeenCalledWith(favoriteMachine);
    });
});
