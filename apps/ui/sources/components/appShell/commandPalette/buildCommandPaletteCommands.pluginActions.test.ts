import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol';
import { DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { createPluginContributedActionController } from '@/components/plugins/actions/pluginContributedActionController';
import type { PluginProjectionAction, PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { buildCommandPaletteCommands } from './buildCommandPaletteCommands';

installDisconnectedServerSocketBoundary();
const machineRpc = vi.hoisted(() => vi.fn<Parameters<typeof createServerScopedMachineRpcBoundaryMock>[0]>());
// The daemon RPC is the system boundary; controller, dispatch policy and DTO projection stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => createServerScopedMachineRpcBoundaryMock(machineRpc));
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const initialStorageState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;

beforeAll(async () => {
    webLocks = installWebLockManagerMock();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async () => new Response('{}', { status: 404 }));
    await loadSyncSingletonForTests();
});
afterEach(async () => {
    machineRpc.mockReset();
    await connection?.dispose();
    connection = undefined;
    storage.setState(initialStorageState, true);
});
afterAll(async () => {
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
    webLocks?.restore();
});

describe('command-palette contributed Actions', () => {
    it('projects an admitted Action with its canonical presentation, occurrence and current Home executor', async () => {
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://command-palette-home.example.test',
            accountId: 'account-command-palette',
            request: async (input) => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
                ? Response.json(createPlainAccountEncryptionCurrentnessFixture())
                : new Response('{}', { status: 404 }),
        });
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.isCurrent()).toBe(true);
        if (!lifetime) throw new Error('Command palette Account did not restore');
        const action: PluginProjectionAction = {
            id: 'sync-notes', occurrenceId: 'commands-occurrence-a', title: 'Sync notes',
            description: 'Synchronize the current notes', icon: 'magic-wand',
            scopes: ['session'], surfaces: ['ui'], placementBindings: ['commandPalette'],
            inputHints: null, slash: null, priority: null, dangerLevel: 'safe', confirmation: null, available: true,
        };
        const projected = PluginProjectedActionV2Schema.parse({
            id: action.id, pluginId: 'acme.commands', occurrenceId: action.occurrenceId,
            title: action.title, description: action.description, icon: action.icon,
            scopes: action.scopes, surfaces: action.surfaces, placementBindings: action.placementBindings,
            execution: { target: 'daemon' }, priority: 0, dangerLevel: action.dangerLevel, available: true,
        });
        const entry: PluginProjectionEntry = {
            pluginId: 'acme.commands', immutableGenerationId: 'generation-7', title: 'Acme commands',
            description: null, version: '1.0.0', enabled: true, generation: 7, generationLabel: '7',
            status: null, provenance: null, diagnostics: [], actions: [action], resources: [], editableSettingsGroups: [],
        };
        machineRpc.mockResolvedValue(DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true, result: { applied: true } }));
        // The controller's public projection port consumes the producer's parsed descriptor;
        // Account currentness still comes from the real restored Home lifetime.
        const controller = createPluginContributedActionController({
            resolveCurrent: () => ({
                pluginProjectionById: { 'acme.commands': entry },
                resolveContributedAction: (identity) => identity.pluginId === projected.pluginId && identity.localId === projected.id ? projected : null,
                host: { machineId: 'machine-command-palette', serverId: lifetime.scope.serverId,
                    sessionId: 'session-command-palette', accountLifetime: lifetime, isCurrent: lifetime.isCurrent },
            }),
        });
        const command = buildCommandPaletteCommands({
            sessionsById: {}, isDev: false, activeSessionId: 'session-command-palette',
            features: { executionRunsEnabled: false, voiceEnabled: false },
            nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
            actions: { execute: async () => ({ ok: true, result: {} }) }, alert: async () => {},
            pluginActionPresentation: { controller, scope: 'session' },
        }).find((candidate) => candidate.id === 'plugin-action:acme.commands/sync-notes');
        expect(command).toMatchObject({ title: 'Sync notes', subtitle: 'Synchronize the current notes', icon: 'magic-wand', category: 'acme.commands' });
        await command?.action();
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-command-palette', serverId: lifetime.scope.serverId,
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload: expect.objectContaining({
                qualifiedActionId: 'acme.commands/sync-notes', expectedContributorOccurrenceId: 'commands-occurrence-a',
                sessionId: 'session-command-palette', executionSurface: 'ui', input: {},
            }),
        }));

        machineRpc.mockClear();
        await connection.dispose();
        connection = undefined;
        expect(lifetime.isCurrent()).toBe(false);
        await command?.action();
        expect(machineRpc).not.toHaveBeenCalled();
    });
});
