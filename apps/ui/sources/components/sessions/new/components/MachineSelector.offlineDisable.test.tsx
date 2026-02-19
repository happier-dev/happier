import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MachineSelector } from './MachineSelector';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({
    lastConfig: null as any,
    lastItems: null as any,
    reset() {
        this.lastConfig = null;
        this.lastItems = null;
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        rt: { themeName: 'light' },
        theme: {
            dark: false,
            colors: {
                textSecondary: '#666',
                status: { connected: '#0f0', disconnected: '#f00' },
                button: { primary: { background: '#00f' } },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/forms/SearchableListSelector', () => ({
    SearchableListSelector: (props: any) => {
        captured.lastConfig = props?.config ?? null;
        captured.lastItems = props?.items ?? null;
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

        await act(async () => {
            renderer.create(
                React.createElement(MachineSelector as any, {
                    machines,
                    selectedMachine: null,
                    onSelect: vi.fn(),
                    showCliGlyphs: false,
                    disableOfflineMachines: true,
                }),
            );
        });

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

        await act(async () => {
            renderer.create(
                React.createElement(MachineSelector as any, {
                    machines,
                    selectedMachine: null,
                    onSelect: vi.fn(),
                    showCliGlyphs: false,
                }),
            );
        });

        expect(Array.isArray(captured.lastItems)).toBe(true);
        expect((captured.lastItems as any[]).map((m) => m.id)).toEqual(['m-ok']);
    });
});
