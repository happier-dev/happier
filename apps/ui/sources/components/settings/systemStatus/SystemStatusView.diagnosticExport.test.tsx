import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMachineFixture, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installSettingsViewCommonModuleMocks({ storage: 'real' });
const clipboard = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));

// Package cleanup retires runtimeFetch after each case. Reclaim the same Home
// HTTP boundary before the next case; its already-imported clients stay real.
beforeEach(async () => { await home.reset(); });
afterEach(async () => { standardCleanup(); await home.reset(); clipboard.mockClear(); });

it.each([
    'C:\\Users\\alice\\.happier', '/Users/alice/.happier',
    'C:\\Users/alice\\.happier/', 'C:\\Users\\alice\\.happier\\\\',
])('exports only the portable home basename through the mounted diagnostic and Copy: %s', async happyHomeDir => {
    const serverId = await home.addHome({ name: 'Studio', serverUrl: 'https://diagnostic-export.test', accountId: 'account-a' });
    const { storage } = await import('@/sync/domains/state/storage');
    const machine = createMachineFixture({ active: false, metadata: { ...createMachineFixture().metadata!, happyHomeDir } });
    storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
    const { SystemStatusView } = await import('./SystemStatusView');
    const screen = await renderScreen(<SystemStatusView />);
    await waitForHomeGovernance(() => expect(screen.find(node => node.props?.title === 'systemStatus.actions.copyJson'
        && typeof node.props?.onPress === 'function').props.disabled).not.toBe(true));
    await pressTestInstanceAsync(screen.find(node => node.props?.title === 'systemStatus.actions.copyJson'
        && typeof node.props?.onPress === 'function'), 'copy mounted diagnostics');
    await waitForHomeGovernance(() => expect(clipboard).toHaveBeenCalled());
    const json = clipboard.mock.calls[0][0];
    const payload = JSON.parse(json);
    expect(payload.machines[0].metadata.happyHomeDirBasename).toBe('.happier');
    expect(json).not.toContain('alice');
});
