import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createLocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    DaemonLocalServiceInventorySnapshotResponseV1Schema,
    DaemonLocalServiceInventoryWatchResponseV1Schema,
    LocalServiceInventorySnapshotV1Schema,
} from '@happier-dev/protocol/local/services/inventory/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { installLocalServiceCensusFixture, localServiceProcfsFixture } from './censusFixture.testkit';
import { scanPlatformLocalServices } from './scan';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createLocalServicesDaemonRuntimeActionExecutor } from '../../actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from '../../featureGate';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { LocalServiceInventorySnapshotV1 } from '@happier-dev/protocol/local/services/inventory/v1';

// CLI imports Socket.IO before the UI reader. Install the canonical external
// transport first; both packages retain their real RPC and Account owners.
vi.mock('socket.io-client', async (importOriginal) => {
    const path = new URL('../../../../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness.ts', import.meta.url).href;
    const boundary = await import(path);
    return boundary.createSocketIoClientBoundary(importOriginal);
});

// Runtime URLs keep UI aliases out of CLI compilation, as in the composed Voice
// suite. Reuse UI's native/storage boundaries and their registered cleanup.
const uiSource = new URL('../../../../../../../ui/sources/', import.meta.url);
await import(new URL('dev/vitestSetup.ts', uiSource).href);
const rpcBoundary: Readonly<{ installSessionActionRpcBoundary(respond: (request: SocketRpcRequestPayload) => Promise<unknown>): unknown }> =
    await import(new URL('dev/testkit/harness/sessionActionRpcBoundary.ts', uiSource).href);
const machineFixtures: Readonly<{
    createPlainMachineRowFixture(input: Readonly<{ id: string; accountId: string }>): unknown;
    createMachineReadBatchResponseFixture(body: unknown, readMachine: (machineId: string) => unknown | null): Response;
}> =
    await import(new URL('dev/testkit/fixtures/machineFixtures.ts', uiSource).href);
const homesBoundary: Readonly<{ serveAccountHomes(input: Readonly<{
    homes: readonly Readonly<{ key: string; serverUrl: string; accountId: string }>[];
    route(request: Readonly<{ path: string; accountId: string | null; body: unknown }>): Response | undefined;
}>): Promise<Readonly<{ homes: Record<string, Readonly<{ id: string }>>; dispose(): void }>> }> =
    await import(new URL('dev/testkit/harness/actionHomesHttpHarness.ts', uiSource).href);
let dispatchMachineRpc: (request: SocketRpcRequestPayload) => Promise<unknown>;
rpcBoundary.installSessionActionRpcBoundary(request => dispatchMachineRpc(request));
const uiReader: Readonly<{ fetchLocalServiceInventorySnapshotViaMachineRpc(input: Readonly<{
    machineId: string; serverId: string; refresh?: boolean;
}>): Promise<Readonly<{ ok: true; snapshot: LocalServiceInventorySnapshotV1 }> | Readonly<{ ok: false; reason: string }>> }> =
    await import(new URL('sync/domains/local/services/inventory/machineRpc.ts', uiSource).href);

// Procfs is the collector's OS boundary. Platform scanning, census, normalization,
// registry/routes and strict RPC projection all use their production implementations.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});

const pid = 1234567;
const workspace = { id: 'accepted-checkout', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo/web', createdAtMs: 1 };
const tcpHeader = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';

function installScan(command: readonly string[], bind: string, ipv6 = false) {
    const rows = [{ pid, command, cwd: workspace.rootPath }];
    installLocalServiceCensusFixture(rows);
    const processFiles = localServiceProcfsFixture(rows);
    vi.mocked(fs.readFile).mockImplementation(async path => {
        if (String(path) === '/proc/net/tcp') return ipv6 ? tcpHeader
            : `${tcpHeader}\n0: ${bind}:1435 00000000:0000 0A 0:0 00:0 0 501 0 12345`;
        if (String(path) === '/proc/net/tcp6') return ipv6
            ? `${tcpHeader}\n0: ${bind}:1435 00000000000000000000000000000000:0000 0A 0:0 00:0 0 501 0 12345` : tcpHeader;
        return processFiles.readFile(String(path));
    });
    vi.mocked(fs.readdir).mockImplementation(async path => (
        String(path) === `/proc/${pid}/fd` ? ['3'] : await processFiles.readdir(String(path))
    ) as never);
    vi.mocked(fs.readlink).mockImplementation(async path => (
        String(path) === `/proc/${pid}/fd/3` ? 'socket:[12345]' : await processFiles.readlink(String(path))
    ));
}
afterEach(() => vi.restoreAllMocks());

describe('Linux inventory scan to Inventory V1 RPC', () => {
    it.each([
        { name: 'long unicode command and wildcard bind', command: ['node', 'serve', '界🚀'.repeat(700)], bind: '00000000', launcherService: false },
        { name: 'empty argv and loopback bind', command: [], bind: '0100007F', launcherService: false },
        { name: 'ordinary listener with missing optional facts', command: ['node', 'vite'], bind: '0100007F', launcherService: true },
        { name: 'IPv6 wildcard bind', command: ['node', 'serve', '世界'], bind: '00000000000000000000000000000000', ipv6: true, launcherService: false },
    ])('emits registered inventory/refresh/launcher outputs for $name without leaking collector fields', async ({ command, bind, ipv6, launcherService }) => {
        installScan(command, bind, ipv6);
        let scanFailure: unknown;
        const runtime = createLocalServicesDaemonRuntime({ machineId: workspace.machineId, startLoop: false,
            processEnv: {}, now: () => 1_000, scan: scanPlatformLocalServices,
            onError: error => { scanFailure = error; },
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                features: { localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true } } }, capabilities: {},
            }) }),
            // The Account-row source is a transport boundary, with no credentials from a live stack.
            workspaceFacts: () => ({ facts: [{ id: workspace.id, path: workspace.rootPath }],
                acceptedWorkspaceRefs: [workspace], diagnostics: [] }),
        });
        try {
            const internal = await runtime.inventoryRoutes.refreshSnapshot();
            expect(scanFailure).toBeUndefined();
            expect(internal.diagnostics).toEqual([]);
            expect(internal.entries).toEqual([expect.objectContaining({ port: 5173, establishedConnections: 0,
                provenance: expect.objectContaining({ workspace: { id: workspace.id, path: workspace.rootPath, association: 'cwd_containment' } }),
            })]);
            // Reproduce the actual originating failure, rather than guessing a procfs diagnostic.
            const unprojected = LocalServiceInventorySnapshotV1Schema.safeParse(internal);
            expect(unprojected.success).toBe(false);
            if (unprojected.success) throw new Error('Expected a private native observation to fail closed Inventory V1');
            expect(unprojected.error.issues).toContainEqual(expect.objectContaining({ code: 'unrecognized_keys',
                path: ['entries', 0], keys: ['establishedConnections'] }));

            const featureGate = createLocalServicesDaemonFeatureGate({ env: {}, resolveServerFeaturesSnapshot: () => ({
                    status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                        localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
                            managed: { enabled: true }, preview: { enabled: true }, actions: { enabled: true } },
                        browser: { enabled: true, viewTargets: { enabled: true } },
                    }, capabilities: {} }),
                }) });
            await featureGate.refresh();
            const actionProducer = createLocalServicesDaemonRuntimeActionExecutor({
                routes: { inventoryRoutes: runtime.inventoryRoutes, launcherRoutes: runtime.launcherRoutes }, featureGate,
            });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), runtimeActionExecute: actionProducer });
            for (const actionId of ['localServices.inventory.list', 'localServices.inventory.refresh', 'localServices.launcher.snapshot'] as const) {
                const output = await actionProducer({ actionId, input: { machineId: workspace.machineId }, context: { surface: 'cli' } });
                expect(output).not.toHaveProperty('errorCode');
                assertActionOutputContract(actionId, output);
                expect(await executor.execute(actionId, { machineId: workspace.machineId }, { surface: 'cli' }))
                    .toMatchObject({ ok: true, result: output });
            }

            const rpc = new RpcHandlerManager({ scopePrefix: workspace.machineId, encryptionMode: 'plain', logger() {} });
            registerDaemonLocalServicesMachineRpcHandlers(rpc, { accountId: 'account-a', machineId: workspace.machineId,
                serverId: workspace.serverId, localServicesInventory: runtime.inventoryRoutes, localServicesLauncher: runtime.launcherRoutes });
            dispatchMachineRpc = request => {
                expect(request.method.startsWith(`${workspace.machineId}:`)).toBe(true);
                return rpc.invokeLocal(request.method.slice(`${workspace.machineId}:`.length), request.params);
            };
            const homes = await homesBoundary.serveAccountHomes({
                homes: [{ key: workspace.serverId, serverUrl: 'https://inventory-wire.example.test', accountId: 'account-a' }],
                route: request => {
                    if (request.path === '/v1/machines/read-batch') {
                        expect(request.accountId).toBe('account-a');
                        return machineFixtures.createMachineReadBatchResponseFixture(request.body, id => id === workspace.machineId
                            ? machineFixtures.createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
                    }
                    if (request.path === `/v1/machines/${workspace.machineId}`) {
                        expect(request.accountId).toBe('account-a');
                        return Response.json({ machine: machineFixtures.createPlainMachineRowFixture({ id: workspace.machineId, accountId: 'account-a' }) });
                    }
                    return undefined;
                },
            });
            try {
                for (const refresh of [false, true]) {
                    const consumed = await uiReader.fetchLocalServiceInventorySnapshotViaMachineRpc({
                        machineId: workspace.machineId, serverId: homes.homes[workspace.serverId]!.id, refresh,
                    });
                    expect(consumed).toMatchObject({ ok: true, snapshot: { machineId: workspace.machineId,
                        entries: [expect.objectContaining({ port: 5173,
                            provenance: expect.objectContaining({ workspace: { id: workspace.id, path: workspace.rootPath, association: 'cwd_containment' } }),
                        })] } });
                    if (!consumed.ok) throw new Error(`UI inventory reader rejected daemon output: ${consumed.reason}`);
                    expect(consumed.snapshot.entries[0]).not.toHaveProperty('establishedConnections');
                }
            } finally { homes.dispose(); }
            for (const method of [RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
                RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH, RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH]) {
                const response = await rpc.invokeLocal(method, { machineId: workspace.machineId,
                    ...(method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH ? { sinceGeneratedAt: 0 } : {}) });
                const parsed = method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH
                    ? DaemonLocalServiceInventoryWatchResponseV1Schema.parse(response)
                    : DaemonLocalServiceInventorySnapshotResponseV1Schema.parse(response);
                if (!('snapshot' in parsed)) throw new Error('Expected the current inventory snapshot');
                expect(parsed.snapshot.entries).toHaveLength(1);
                expect(parsed.snapshot.entries[0]?.provenance?.workspace?.id).toBe(workspace.id);
                expect(parsed.snapshot.entries[0]).not.toHaveProperty('establishedConnections');
                assertActionOutputContract(method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
                    ? 'localServices.inventory.refresh' : 'localServices.inventory.list', parsed.snapshot);
            }
            const launcher = DaemonLocalServiceLauncherSnapshotResponseV1Schema.parse(await rpc.invokeLocal(
                RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, { machineId: workspace.machineId },
            ));
            assertActionOutputContract('localServices.launcher.snapshot', launcher.snapshot);
            // Unclassified listeners remain visible in inventory without becoming launcher Services.
            expect(launcher.snapshot.targets).toEqual(launcherService ? [expect.objectContaining({
                sourceClass: { kind: 'inventory_entry', inventoryEntryId: internal.entries[0]!.id },
            })] : []);
            expect(runtime.inventoryRegistry.getSnapshot().entries[0]?.establishedConnections).toBe(0);
        } finally { await runtime.stop(); }
    });
});
