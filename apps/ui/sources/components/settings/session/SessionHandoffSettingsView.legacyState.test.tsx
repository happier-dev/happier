import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

// Current daemon filesystem diagnostic: original 0.2 directory is preserved.
// Other enrolled Machines cannot answer; neither condition requires recovery.
const harness = createWorkspaceSyncHarness(request => {
    if (request.method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT) throw new Error(`Unexpected RPC ${request.method}`);
    return request.machineId === 'machine-a'
        ? { status: 'preserved', path: '/home/alice/.happier/servers/home/workspace-replication' }
        : { error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
});
await harness.ready;
const { storage } = await import('@/sync/domains/state/storage');
const { inspectWorkspaceSyncLegacyState } = await import('@/sync/ops/workspaceSync');
const { default: SessionHandoffSettingsView } = await import('./SessionHandoffSettingsView');
afterEach(async () => { standardCleanup(); await harness.dispose(); });

it('keeps Session handoff settings free of recovery rows for preserved 0.2 files and current enrolled daemons', async () => {
    await harness.reset();
    const machines = Object.values(storage.getState().machines).map(machine => ({ ...machine,
        daemonState: { ...machine.daemonState, cliVersion: '0.2.10' },
    }));
    storage.getState().applyMachines(machines, true, { sourceServerId: harness.serverId, sourceAccountId: harness.accountId });
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [], relationships: [] });
    await expect(inspectWorkspaceSyncLegacyState({ controllerMachineId: 'machine-a' })).resolves.toMatchObject({ status: 'preserved' });
    const screen = await renderSettingsView(<SessionHandoffSettingsView />);
    await vi.waitFor(() => expect(screen.findGroup('workspaceSync.legacyRecovery.title')).toBeNull());
    expect(screen.listRows('workspace-sync-legacy-')).toEqual([]);
    expect(screen.findAll(node => node.props.testIDPrefix === 'session-handoff-workspace-sync-mode')).not.toHaveLength(0);
});
