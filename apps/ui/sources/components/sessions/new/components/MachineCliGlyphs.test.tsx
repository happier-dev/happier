import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installMachineComponentCommonModuleMocks } from '@/components/machines/machineComponentTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { machineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import { MachineCliGlyphs } from './MachineCliGlyphs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installMachineComponentCommonModuleMocks();

const rpc = vi.hoisted(() => vi.fn());
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
// Expo's native crypto module is unavailable in the Node renderer; retain real OS randomness.
vi.mock('expo-crypto', async () => {
    const { randomBytes, randomUUID } = await import('node:crypto');
    return { randomUUID, getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)),
        getRandomBytesAsync: async (size: number) => new Uint8Array(randomBytes(size)) };
});
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'glyph-account' })).toString('base64')}.signature` }),
    } });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: navigation.push } }).module;
});

// Stub the Agent mark so the test does not depend on real SVG assets;
// it exposes the resolved agentId so we can assert the right logo is rendered.
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: ({ agentId, testID }: { agentId: string; testID?: string }) =>
        React.createElement('AgentIcon', { testID: testID ?? `machine-cli-logo:${agentId}`, agentId }),
}));

afterEach(() => {
    standardCleanup();
    rpc.mockReset();
    navigation.push.mockClear();
    storage.setState(storage.getInitialState(), true);
});

describe('MachineCliGlyphs', () => {
    it('keeps case-variant configured definitions as distinct glyphs without duplicate React keys', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const server = await upsertServerProfile({ serverUrl: 'https://glyph-definition-identity.example.test' });
        const scope = { serverId: server.id, accountId: 'glyph-account' };
        const machine = createMachineFixture({ id: 'glyph-definitions', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const item: MachineAgentInventoryItem = {
            agentId: 'custom-acp', title: 'Goose', installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'status_only' },
            platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
        };
        machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
            status: 'ready', items: [{ ...item, definitionId: 'Goose' }, { ...item, definitionId: 'goose', title: 'goose' }], lastCheckedAt: 12,
        });
        const tree = await renderScreen(<MachineCliGlyphs machineId={machine.id} serverId={server.id} isOnline autoDetect={false} />);
        expect(tree.findAllByType('AgentIcon')).toHaveLength(2);
        expect(errors.mock.calls.filter(args => String(args[0]).includes('Encountered two children with the same key'))).toEqual([]);
    });

    it('stays quiet while no installed Agent is known: no placeholder mark and no control', async () => {
        const server = await upsertServerProfile({ serverUrl: 'https://glyph-empty.example.test' });
        const scope = { serverId: server.id, accountId: 'glyph-account' };
        const machine = createMachineFixture({ id: 'glyph-empty', active: false, activeAt: 0, daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const tree = await renderScreen(React.createElement(MachineCliGlyphs, {
            machineId: machine.id, serverId: server.id, isOnline: false, autoDetect: false,
        }));
        expect(tree.findAllByTestId('machine-agent-glyphs')).toHaveLength(0);
        expect(tree.findAllByType('Text')).toHaveLength(0);
    });

    it('renders installed inventory facts without probing a cache-only machine row', async () => {
        const server = await upsertServerProfile({ serverUrl: 'https://glyph-inventory.example.test' });
        const scope = { serverId: server.id, accountId: 'glyph-account' };
        const machine = createMachineFixture({ id: 'glyph-machine', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const item: MachineAgentInventoryItem = {
            agentId: 'cursor', title: 'Cursor', installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'status_only' },
            platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
        };
        machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
            status: 'ready', items: [item, { ...item, agentId: 'antigravity', installed: false,
                dependencies: [{ key: 'dep.antigravity.agy-acp-server', installed: true, version: null }] }], lastCheckedAt: 12,
        });
        const tree = await renderScreen(React.createElement(MachineCliGlyphs, {
            machineId: machine.id,
            serverId: server.id,
            isOnline: true,
            autoDetect: false,
        }));

        await vi.waitFor(() => expect(tree.findAllByType('AgentIcon').map((node) => node.props.agentId)).toEqual(['cursor']));
        expect(rpc).not.toHaveBeenCalled();
        await tree.pressByTestId('machine-agent-glyphs');
        expect(navigation.push).toHaveBeenCalledWith(`/settings/machines/${machine.id}?serverId=${encodeURIComponent(server.id)}`);
    });

    it('gives an installed Agent without a brand mark the neutral mark instead of an empty slot', async () => {
        const server = await upsertServerProfile({ serverUrl: 'https://glyph-unmarked.example.test' });
        const scope = { serverId: server.id, accountId: 'glyph-account' };
        const machine = createMachineFixture({ id: 'glyph-unmarked', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const item: MachineAgentInventoryItem = {
            agentId: 'cursor', title: 'Cursor', installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'status_only' },
            platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
        };
        machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
            status: 'ready', items: [item, { ...item, agentId: 'custom-acp', title: 'Custom ACP Agent' }], lastCheckedAt: 12,
        });
        const tree = await renderScreen(React.createElement(MachineCliGlyphs, {
            machineId: machine.id, serverId: server.id, isOnline: true, autoDetect: false,
        }));
        await vi.waitFor(() => expect(tree.findAllByType('AgentIcon').map((node) => node.props.agentId)).toEqual(['cursor', null]));
    });

    it('ignores machine heartbeats but updates every mounted row when inventory changes, including after reopening', async () => {
        const server = await upsertServerProfile({ serverUrl: 'https://glyph-subscription.example.test' });
        const scope = { serverId: server.id, accountId: 'glyph-account' };
        const machine = createMachineFixture({ id: 'glyph-subscription', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        const item: MachineAgentInventoryItem = {
            agentId: 'cursor', title: 'Cursor', installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'status_only' },
            platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
        };
        machineAgentInventoryStore.publish(key, { status: 'ready', items: [item], lastCheckedAt: 12 });
        let commits = 0;
        const renderPicker = () => renderScreen(
            <React.Profiler id="machine-glyphs" onRender={() => { commits += 1; }}>
                {['favorites', 'recent', 'all'].map((section) => (
                    <MachineCliGlyphs key={section} machineId={machine.id} serverId={server.id} isOnline autoDetect={false} />
                ))}
            </React.Profiler>,
        );
        const first = await renderPicker();
        await vi.waitFor(() => expect(first.findAllByType('AgentIcon').map((node) => node.props.agentId)).toEqual(['cursor', 'cursor', 'cursor']));
        await flushHookEffects({ cycles: 2 });
        const beforeHeartbeat = commits;
        await act(async () => {
            storage.setState({ machineListByServerId: { [server.id]: [{ ...machine, seq: machine.seq + 1, activeAt: Date.now() + 1000 }] } });
        });
        await flushHookEffects({ cycles: 2 });
        expect(commits).toBe(beforeHeartbeat);
        await act(async () => {
            machineAgentInventoryStore.publish(key, { status: 'ready', items: [{ ...item, agentId: 'codex', title: 'Codex' }], lastCheckedAt: 13 });
        });
        expect(first.findAllByType('AgentIcon').map((node) => node.props.agentId)).toEqual(['codex', 'codex', 'codex']);
        await first.unmount();
        const reopened = await renderPicker();
        await vi.waitFor(() => expect(reopened.findAllByType('AgentIcon').map((node) => node.props.agentId)).toEqual(['codex', 'codex', 'codex']));
        expect(rpc).not.toHaveBeenCalled();
    });
});
