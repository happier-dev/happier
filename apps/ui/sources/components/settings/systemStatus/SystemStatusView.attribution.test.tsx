import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { writeCachedMachineDoctorSnapshot } from './cache/machineDoctorSnapshotCache';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key) => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-updates', () => ({
    isEnabled: false,
    updateId: null,
    createdAt: null,
    channel: null,
    runtimeVersion: null,
    isEmbeddedLaunch: true,
    useUpdates: () => ({}),
}));

afterEach(() => {
    standardCleanup();
    storage.setState(storage.getInitialState(), true);
});

describe('SystemStatusView daemon attribution', () => {
    it.each([
        ['root trailing slash', 'https://relay.example.com/', 'https://relay.example.com', 'account-1', false],
        ['default port and host casing', 'https://RELAY.example.com:443/', 'https://relay.example.com', 'account-1', false],
        ['path trailing slash', 'https://relay.example.com/relay/', 'https://relay.example.com/relay', 'account-1', false],
        ['loopback spelling', 'http://localhost:3005/relay', 'http://127.0.0.1:3005/relay/', 'account-1', false],
        ['different host', 'https://relay.example.com/', 'https://other.example.com', 'account-1', true],
        ['different path', 'https://relay.example.com/one', 'https://relay.example.com/two', 'account-1', true],
        ['different scheme', 'https://relay.example.com/', 'http://relay.example.com', 'account-1', true],
        ['different port', 'https://relay.example.com/', 'https://relay.example.com:8443', 'account-1', true],
        ['different account', 'https://relay.example.com/', 'https://relay.example.com', 'account-2', true],
        ['invalid URL', 'https://relay.example.com/', 'https://[invalid', 'account-1', true],
        ['invalid URL with different account', 'https://relay.example.com/', 'https://[invalid', 'account-2', true],
    ])('%s', async (_name, activeUrl, daemonUrl, daemonAccountId, mismatch) => {
        const server = upsertAndActivateServer({ serverUrl: activeUrl });
        // Keep the cached-attribution path real without issuing a machine RPC on mount.
        const machine = createMachineFixture({ active: false, activeAt: 0 });
        storage.setState({
            isDataReady: true,
            profile: { ...storage.getState().profile, id: 'account-1' },
            machines: { [machine.id]: machine },
            machineListByServerId: { [server.id]: [machine] },
            machineListStatusByServerId: { [server.id]: 'idle' },
        });
        writeCachedMachineDoctorSnapshot({
            serverId: server.id,
            machineId: machine.id,
            cachedAt: Date.now(),
            snapshot: {
                capturedAt: new Date().toISOString(),
                server: { activeServerId: server.id, serverUrl: daemonUrl, publicServerUrl: daemonUrl, webappUrl: daemonUrl },
                accountId: daemonAccountId,
                settings: { activeServerId: server.id, servers: [], knownAccountIds: [daemonAccountId] },
            },
        });

        const { SystemStatusView } = await import('./SystemStatusView');
        const screen = await renderScreen(<SystemStatusView />);
        const content = screen.getTextContent();
        expect(content).toContain('systemStatus.machine.daemonAttribution');
        expect(content.includes('systemStatus.mismatch')).toBe(mismatch);
    });
});
