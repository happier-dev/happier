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
    reset() {
        this.lastConfig = null;
        this.lastItems = null;
        this.lastRecentItems = null;
        this.lastFavoriteItems = null;
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
        return null;
    },
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
});
