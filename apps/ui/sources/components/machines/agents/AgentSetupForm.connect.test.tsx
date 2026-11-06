import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { Modal } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
const { AgentSetupForm } = await import('./AgentSetupForm');
const connections: Awaited<ReturnType<typeof restoreServerAccountForTest>>[] = [];
const before = storage.getState();
const installed: MachineAgentInventoryItem = {
    agentId: 'codex', title: 'Codex', installed: true, version: '1', latestVersion: null,
    update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
    platform: { supported: true }, install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
};

afterEach(async () => { standardCleanup(); for (const connection of connections.splice(0).reverse()) await connection.dispose(); storage.setState(before, true); });

describe('Machine agent Connect handoff', () => {
    it.each([false, true])('keeps the originating Home, Account and Machine (other Home active: %s)', async (switchHome) => {
        await homes.reset();
        const original = await homes.addHome({ name: 'Original', serverUrl: 'https://agent-connect-original.test', accountId: 'original-account', currentAccount: true });
        const other = await homes.addHome({ name: 'Other', serverUrl: 'https://agent-connect-other.test', accountId: 'other-account' });
        await setActiveServerId(original);
        connections.push(await restoreServerAccountForTest({ serverUrl: 'https://agent-connect-original.test',
            accountId: 'original-account', configureSocket: configureConnectedServerSocketBoundary,
            additionalRequestOrigins: ['https://agent-connect-other.test'], request: homes.request }));
        const scope = { serverId: original, accountId: 'original-account' };
        const machine = createMachineFixture({ id: 'chosen-machine', active: false, activeAt: 1 });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [original]: [machine] } });
        const binding = await renderHook(() => useServerCredentialAccountScopeBinding(original));
        await vi.waitFor(() => expect(binding.getCurrent().binding?.scope).toEqual(scope));
        const screen = await renderScreen(<AgentSetupForm serverId={original} machineId={machine.id}
            machineName="Chosen" agentId="codex" layout="full" testID="agent-connect" />);
        await act(async () => { machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
            status: 'ready', items: [installed], lastCheckedAt: 1,
            connectedServicesByAgentId: { codex: [{ serviceId: 'openai-codex', title: 'ChatGPT', connected: false, healthy: false, profileLabel: null }] },
        }); });
        await vi.waitFor(() => expect(screen.findByTestId('agent-connect.connectService'), screen.getTextContent()).not.toBeNull());
        // A retained form keeps its own operand while navigation focuses a different Home.
        if (switchHome) await act(async () => {
            await setActiveServerId(other);
            connections.push(await restoreServerAccountForTest({ serverUrl: 'https://agent-connect-other.test',
                accountId: 'other-account', configureSocket: configureConnectedServerSocketBoundary,
                additionalRequestOrigins: ['https://agent-connect-original.test'], request: homes.request }));
        });
        vi.mocked(Modal.show).mockClear();
        await screen.pressByTestIdAsync('agent-connect.connectService');
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ request: expect.objectContaining({
            scope,
            initialMachineTarget: { serverIdentityId: original, machineId: machine.id },
            service: BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID['openai-codex'].service,
        }) }) }));
        const modal = vi.mocked(Modal.show).mock.calls.at(-1)![0];
        if (!modal.component) throw new Error('Expected the connected account sheet');
        const sheet = await renderScreen(React.createElement(modal.component,
            { ...modal.props, onClose: () => modal.onRequestClose?.() }));
        if (switchHome) {
            expect(sheet.findHostByTestId('connect-sheet:unavailable')).not.toBeNull();
            expect(sheet.root.findAll(node => node.props.diagnosticCode === 'account_scope_mismatch')).not.toHaveLength(0);
        } else {
            expect(sheet.findHostByTestId('connect-sheet:account'), sheet.getTextContent()).not.toBeNull();
        }
        modal.onRequestClose?.();
        await sheet.unmount();
        await screen.unmount();
        await binding.unmount();
    });
});
