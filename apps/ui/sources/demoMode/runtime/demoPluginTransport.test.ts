import { describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { seedDemoWorld, clearDemoWorld } from '../seed/seedDemoWorld';
import { DEMO_MACHINE_ID, DEMO_PROJECT_PATH } from '../world/constants';
import { getDemoModeServerId } from './enterExitDemoMode';
import { TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1, TriageStartEntrySessionResultV1Schema } from '../../../../../packages/plugins/triage/src/actions/entrySessionProtocol';
import { TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { enterDemoMode, exitDemoMode } from './enterExitDemoMode';
import { createDemoPluginTransport } from './demoPluginTransport';
import { buildDemoChannelsWorld } from '../world/channels';
import { parseBindingsResource, parseConnectionsResource } from '../../../../../packages/plugins/channels/src/ui/conversationRows';
import { createDemoPluginDataClient } from './demoPluginDataClient';
import { bindTriageDurableAccountV1 } from '../../../../../packages/plugins/triage/src/ui/durable/accountDurableState';
import { listTriagePinnedEntries, setTriageEntryPinned } from '../../../../../packages/plugins/triage/src/actions/userMarks';
import { createDemoTriageRuntime } from './demoTriageRuntime';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesResultV1Schema } from '../../../../../packages/plugins/triage/src/actions/listEntriesProtocol';
import { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/triage/src/actions/actionsCatalogProtocol';
import { TRIAGE_DEFAULT_FIX_ACTION_ID_V1 } from '@happier-dev/triage-protocol/v1';

describe('demo plugin transport lifetime', () => {
    it('offers the configured Fix as a direct Session handoff while preserving its repository intent', async () => {
        enterDemoMode('demo-home');
        const runtime = createDemoTriageRuntime(createPluginSurfaceContextFixture({ accountEncryptionMode: 'plain' }));
        try {
            const result = await runtime.host.api.executeAction(TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, { v: 1 });
            expect(result).toMatchObject({ actions: expect.arrayContaining([expect.objectContaining({
                actionId: TRIAGE_DEFAULT_FIX_ACTION_ID_V1, workspaceMode: 'repository', target: expect.objectContaining({ delivery: 'send' }),
            })]) });
        } finally { runtime.host.dispose(); exitDemoMode(); }
    });
    it('starts a linked Session with the selected issue and prompt through the real Triage orchestration', async () => {
        const browser = await installBrowserRuntimeForTests({ url: 'https://demo-owner.example.test' });
        const original = storage.getState();
        const opened: string[] = [];
        const selectedDirectory = `${DEMO_PROJECT_PATH}/selected-repository`;
        vi.useFakeTimers();
        await seedDemoWorld();
        const runtime = createDemoTriageRuntime(createPluginSurfaceContextFixture({ accountEncryptionMode: 'plain' }), {
            openSession: async sessionId => { opened.push(sessionId); },
        });
        try {
            const item = runtime.world.find(item => item.source.pluginId === 'happier.linear')!;
            const entryRef = { source: item.source, ...item.localRef };
            const result = TriageStartEntrySessionResultV1Schema.parse(await runtime.host.api.executeAction(
                TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1, { v: 1, workspaceMode: 'repository', entryRef,
                    sourceInstanceId: item.sourceInstanceId, display: { locator: item.locator, scopeLabel: item.snapshot.scopeLabel },
                    destination: { kind: 'new', creationKey: 'demo-triage-start-contract',
                        spawn: { executionTarget: { serverId: getDemoModeServerId()!, machineId: DEMO_MACHINE_ID },
                            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                        materialization: { kind: 'selectedProject', directory: selectedDirectory } },
                    delivery: { kind: 'send', text: 'Investigate this issue and fix the blocker.',
                        attachments: [{ entryRef, sourceInstanceId: item.sourceInstanceId, title: item.snapshot.title,
                            display: { locator: item.locator, scopeLabel: item.snapshot.scopeLabel } }],
                        idempotencyKey: 'demo-triage-start-input', returnResult: true } }));
            expect(result).toMatchObject({ type: 'opened', disposition: 'created', delivery: 'accepted' });
            if (result.type !== 'opened') throw new Error('Expected an opened Session');
            expect(storage.getState().sessions[result.sessionId]).toMatchObject({ serverId: getDemoModeServerId(), metadata: { path: selectedDirectory } });
            expect(Object.values(storage.getState().sessionMessages[result.sessionId]?.messagesById ?? {}))
                .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'user-text', text: 'Investigate this issue and fix the blocker.',
                    meta: expect.objectContaining({ [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: expect.objectContaining({
                        composerAttachments: [expect.objectContaining({ value: expect.objectContaining({ entryRef }) })],
                    }) }) })]));
            expect(await runtime.host.api.executeAction(TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1,
                { v: 1, entryRef, sourceInstanceId: item.sourceInstanceId })).toMatchObject({ links: [expect.objectContaining({ sessionId: result.sessionId })] });
            expect(opened).toEqual([result.sessionId]);
        } finally { runtime.host.dispose(); await vi.runOnlyPendingTimersAsync(); await clearDemoWorld(); storage.setState(original, true); browser.restore(); vi.useRealTimers(); }
    });
    it('composes the configured provider responses through the real Triage list owner', async () => {
        enterDemoMode('demo-home');
        const runtime = createDemoTriageRuntime(createPluginSurfaceContextFixture({ accountEncryptionMode: 'plain' }));
        try {
            const result = TriageListEntriesResultV1Schema.parse(await runtime.host.api.executeAction(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
                { v: 1, sources: { kind: 'allConfigured' }, limit: 20, order: 'smart' }));
            expect(new Set(result.window.rows.map(row => row.entryRef.source.pluginId)))
                .toEqual(new Set(runtime.world.map(item => item.source.pluginId)));
            expect(result.window.rows).toHaveLength(4);
        } finally { runtime.host.dispose(); exitDemoMode(); }
    });
    it('keeps real Triage pin writes readable through its durable binding until the mount retires', async () => {
        enterDemoMode('demo-home');
        const host = createDemoPluginTransport({ pluginId: 'happier.triage', surface: createPluginSurfaceContextFixture() });
        const client = createDemoPluginDataClient({ pluginId: 'happier.triage', accountLifetime: host.accountLifetime });
        const durable = bindTriageDurableAccountV1(client);
        if (durable.collections === null) throw new Error('Demo Account data binding is unavailable');
        const deps = { collections: durable.collections, nowMs: () => 1000 };
        const entryRef = { source: { pluginId: 'happier.linear', localId: 'linear-issues' },
            kindId: 'issue', collisionScope: 'northstar', entryId: 'ENG-42' };
        try {
            await expect(setTriageEntryPinned({ v: 1, entryRef, pinned: true,
                displayAtMark: { title: 'Keep session context across reconnects', scopeLabel: 'Northstar' } }, deps))
                .resolves.toMatchObject({ status: 'pinned' });
            const page = await listTriagePinnedEntries({ v: 1, limit: 20 }, deps);
            expect(page.pins.map(pin => pin.entryRef)).toEqual([entryRef]);
            host.dispose();
            await expect(listTriagePinnedEntries({ v: 1, limit: 20 }, deps)).rejects.toMatchObject({ code: 'plugin_account_storage_unavailable' });
        } finally {
            host.dispose();
            exitDemoMode();
        }
    });
    it('provides schema-backed Channels resources for all four staged services', async () => {
        enterDemoMode('demo-home');
        const world = buildDemoChannelsWorld();
        const host = createDemoPluginTransport({ pluginId: 'happier.channels', surface: createPluginSurfaceContextFixture(),
            readResource: resource => resource.localId === 'connections-v1' ? { connections: world.connections } : { bindings: world.bindings },
        });
        try {
            const connections = await host.api.readResource({ pluginId: 'happier.channels', localId: 'connections-v1' });
            const bindings = await host.api.readResource({ pluginId: 'happier.channels', localId: 'bindings-v1' });
            expect(parseConnectionsResource(connections)).toMatchObject({ kind: 'ready', connections: world.connections });
            expect(parseBindingsResource(bindings)).toMatchObject({ kind: 'ready', bindings: world.bindings });
        } finally {
            host.dispose();
            exitDemoMode();
        }
    });
    it('serves Resource bytes through the real mounted host and retires with the demo mount', async () => {
        enterDemoMode('demo-home');
        const resource = { pluginId: 'happier.channels', localId: 'bindings-v1' };
        const surface = createPluginSurfaceContextFixture();
        const host = createDemoPluginTransport({ pluginId: resource.pluginId, surface,
            readResource: () => ({ bindings: [{ bindingId: 'launch-room' }] }),
        });
        try {
            const result = await host.api.readResource(resource);
            expect(JSON.parse(new TextDecoder().decode(result.bytes))).toEqual({ bindings: [{ bindingId: 'launch-room' }] });
            host.dispose();
            await expect(host.api.readResource(resource)).rejects.toMatchObject({ code: 'stale_surface' });
        } finally {
            host.dispose();
            exitDemoMode();
        }
    });
});
