import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import type { ComputerProviderSettingsRow } from '@/sync/domains/computer/computerProviderSettings';

import { MachineComputerUseSectionView, type MachineComputerUseSectionViewProps } from './MachineComputerUseSection';

installUiListsCommonModuleMocks();

const rows: readonly ComputerProviderSettingsRow[] = [
    { provider: 'cua', enabled: true, isDefault: true, availability: 'ready' },
    { provider: 'agent-desktop', enabled: false, isDefault: false, availability: 'not_installed' },
];
const base = (overrides: Partial<MachineComputerUseSectionViewProps> = {}): MachineComputerUseSectionViewProps => ({
    machineName: 'devbox', online: true, unavailable: false, providers: rows, mutation: { phase: 'idle' },
    preferences: { enabledProviders: ['cua'], defaultProvider: 'cua' },
    onToggle: vi.fn(), onRepair: vi.fn(), onChooseDefault: vi.fn(), ...overrides,
});

describe('Computer use page body', () => {
    it.each([false, true])('allows native provider installation only for Manage (%s)', async (canManage) => {
        const props = base({ canManage, providers: [rows[0]!, { ...rows[1]!, enabled: true }] });
        const screen = await renderSettingsView(<MachineComputerUseSectionView {...props} />);
        expect(screen.findByTestId('machine-computer-use-provider-agent-desktop.install') !== null).toBe(canManage);
        expect(screen.findByTestId('machine-computer-use-provider-agent-desktop.switch')?.props.disabled).toBe(!canManage);
        await screen.unmount();
    });

    it('keeps the default on without a switch, and makes another enabled provider the default from its row', async () => {
        const both: readonly ComputerProviderSettingsRow[] = [rows[0]!, { ...rows[1]!, enabled: true, availability: 'ready' }];
        const props = base({ providers: both, preferences: { enabledProviders: ['cua', 'agent-desktop'], defaultProvider: 'cua' } });
        const screen = await renderSettingsView(<MachineComputerUseSectionView {...props} />);
        expect(screen.findByTestId('machine-computer-use-provider-cua.switch')).toBeNull();
        expect(screen.findByTestId('machine-computer-use-provider-cua.makeDefault')).toBeNull();
        await screen.pressByTestIdAsync('machine-computer-use-provider-agent-desktop.makeDefault');
        expect(props.onChooseDefault).toHaveBeenCalledWith('agent-desktop');
        expect(props.onRepair).not.toHaveBeenCalled();
    });

    it('puts a retry on the row whose install failed and routes it to that provider', async () => {
        const props = base({ mutation: { phase: 'failed', errorCode: 'install_failed', error: 'interrupted', provider: 'agent-desktop' } });
        const screen = await renderSettingsView(<MachineComputerUseSectionView {...props} />);
        expect(screen.findByTestId('machine-computer-use-provider-cua.retry')).toBeNull();
        await screen.pressByTestIdAsync('machine-computer-use-provider-agent-desktop.retry');
        expect(props.onRepair).toHaveBeenCalledWith(rows[1]);
    });

    it('locks an enabled provider while the Machine is unreachable and explains the next step on its row', async () => {
        const props = base({ online: false, providers: [{ ...rows[0]!, isDefault: false, availability: 'unknown' },
            { ...rows[1]!, enabled: true, isDefault: true, availability: 'unknown' }] });
        const screen = await renderSettingsView(<MachineComputerUseSectionView {...props} />);
        const toggle = screen.findByTestId('machine-computer-use-provider-cua.switch');
        expect(toggle?.props.value).toBe(true);
        expect(toggle?.props.disabled).toBe(true);
        expect(toggle?.props.accessibilityHint).toBeTruthy();
        expect(screen.findByTestId('machine-computer-use-provider-cua.status')).not.toBeNull();
        expect(props.onToggle).not.toHaveBeenCalled();
    });

    it('shows loading until preferences are readable, and says when they cannot be', async () => {
        expect((await renderSettingsView(<MachineComputerUseSectionView {...base({ preferences: null })} />))
            .findByTestId('machine-computer-use-loading')).not.toBeNull();
        expect((await renderSettingsView(<MachineComputerUseSectionView {...base({ preferences: null, unavailable: true })} />))
            .findByTestId('machine-computer-use-unavailable')).not.toBeNull();
    });
});
