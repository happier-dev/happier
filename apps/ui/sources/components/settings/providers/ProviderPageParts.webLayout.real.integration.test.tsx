// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { View } from 'react-native';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { getStorage } from '@/sync/domains/state/storage';

// Resolve the actual browser platform before storage's static imports load UI owners.
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

it.each([1, 2])('keeps current provider header controls inside a phone pane at %sx text', async scale => {
    const { ProviderHeaderActions } = await import('./ProviderPageParts');
    const { PageHeader } = await import('@/components/ui/layout/PageHeader');
    const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
    const { PageHeaderStateSwitch, PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const localSettings = getStorage().getState().localSettings;
    try {
        await act(async () => { getStorage().setState({ localSettings: { ...localSettings, uiFontScale: scale } }); });
        await act(async () => root.render(<PageHeader title="Provider" actionsPlacement="page" actions={
            <ProviderHeaderActions>
                <RoundButton testID="test" title="Test" size="small" display="secondary" onPress={() => {}} />
                <PageHeaderStateSwitch testID="enabled" label="Enabled" value onValueChange={() => {}} />
                <PageHeaderMenu testID="more" actions={[{ id: 'delete', title: 'Delete', onSelect: () => {} }]} />
            </ProviderHeaderActions>
        } />));
        const width = 320;
        const layout = await measureWebLayout(host, { viewport: { width, height: 800 } });
        for (const id of ['test', 'enabled.control', 'more.trigger']) {
            expect(layout.rect(id).left).toBeGreaterThanOrEqual(0);
            expect(layout.rect(id).right).toBeLessThanOrEqual(width);
            expect(layout.rect(id).clipped).toBe(false);
        }
    } finally {
        await act(async () => root.unmount());
        getStorage().setState({ localSettings });
        host.remove();
    }
});

it.each([1, 2])('keeps the current machine context and picker inside a phone pane at %sx text', async scale => {
    const { MachineAdministrationContextBar } = await import('../machines/MachineAdministrationContextBar');
    const target = { serverIdentityId: 'home-a', machineId: 'machine-a' };
    const candidate = { target, displayName: 'Development workstation', serverLabel: 'Personal Home',
        availability: 'online' as const, observation: 'live' as const, observedAt: 1 };
    const selection: MachineAdministrationTargetSelectionV1 = {
        candidates: [candidate], pickerRows: [], selectedTarget: target,
        selectedTargetServerMatchesActiveAccount: false,
        state: resolveMachineAdministrationTargetState({ storedTarget: target, candidates: [candidate] }),
        canExecute: true, selectTarget: () => {}, clearTarget: () => {}, resolveExecutionTarget: () => null,
    };
    const label = 'Setup and status on';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const localSettings = getStorage().getState().localSettings;
    try {
        await act(async () => { getStorage().setState({ localSettings: { ...localSettings, uiFontScale: scale } }); });
        await act(async () => root.render(<View><MachineAdministrationContextBar label={label}
            selection={selection} testIDPrefix="scope" /></View>));
        const width = 320;
        const layout = await measureWebLayout(host, { viewport: { width, height: 800 }, texts: [label] });
        const chip = layout.rect('scope.chip');
        const text = layout.textRects(label)[0]!;
        for (const box of [chip, text]) {
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(width);
            expect(box.clipped).toBe(false);
        }
        expect(chip.left >= text.right || chip.top >= text.bottom).toBe(true);
    } finally {
        await act(async () => root.unmount());
        getStorage().setState({ localSettings });
        host.remove();
    }
});
