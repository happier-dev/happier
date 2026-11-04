import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { BotTemplateDraftV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Only the network SDK is replaced; actual Account/Machine admission and catalog demand stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { BotTemplateNeedsSection } = await import('./BotTemplateNeedsSection');
const { BotTemplateAgentSection } = await import('./BotTemplateAgentSection');
const { createBotTemplateEditorBuffer } = await import('./botTemplateEditorBuffer');

afterEach(async () => {
    standardCleanup();
    clearDaemonMergedProjectionCacheForTests();
    await disconnectActiveServerConnection();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
});
afterAll(async () => { await network.dispose(); });

describe('template editor catalog demand', () => {
    it('makes zero catalog requests with Add and Agent closed, then reaches the real Machine catalog when each control opens', async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        const home = await network.addHome('https://template-editor-demand.test', 'author');
        network.setRpcAckResponder(async () => ({ ok: true, result: { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {} } } }));
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        clearDaemonMergedProjectionCacheForTests();
        const session = createSessionFixture({ id: 'source', serverId: home.id });
        storage.getState().applySessions([session]);
        const draft = BotTemplateDraftV1Schema.parse({ v: 1, state: 'draft', sourceSessionRef: { serverId: home.id, sessionId: session.id },
            releaseArtifactId: '32c55218-6b01-40ef-8237-e53dc6de68d3',
            content: { v: 1, identity: { name: 'Review', description: '' }, instructions: { markdown: '' }, memoryRules: [], skills: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } }, candidates: { memoryRules: [], skills: [] } });
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        const save = async () => ({ ok: true as const, revision: { headerVersion: 2, bodyVersion: 2 } });
        const screen = await renderScreen(<><BotTemplateNeedsSection buffer={buffer} save={save} scope={{ serverId: home.id, accountId: 'author' }} />
            <BotTemplateAgentSection buffer={buffer} save={save} /></>, {
            wrapper: ({ children }) => <ListPresentationProvider value="page">{children}</ListPresentationProvider>,
        });
        const reads = () => network.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        expect(reads()).toHaveLength(0);
        await screen.pressByTestIdAsync('bot-template-need-add');
        await vi.waitFor(async () => { await act(async () => {}); expect(reads()).toHaveLength(1); });
        await screen.pressByTestIdAsync('bot-template-need-add');
        await act(async () => { clearDaemonMergedProjectionCacheForTests(); });
        await screen.pressByTestIdAsync('bot-template-agent-trigger');
        await vi.waitFor(async () => { await act(async () => {}); expect(reads()).toHaveLength(2); });
    });
});
