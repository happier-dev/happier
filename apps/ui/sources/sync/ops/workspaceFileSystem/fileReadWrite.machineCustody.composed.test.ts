import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createInstalledFilesystemMachineFixture } from '../../../../../cli/src/daemon/testkit/installedFilesystemMachineFixture';

// Preserve the CLI fixture's real loopback currentness channel while keeping
// the UI's remote Home Socket.IO connection at its canonical transport boundary.
vi.mock('socket.io-client', async importOriginal => {
    const harness = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    const boundary = await harness.createSocketIoClientBoundary(importOriginal);
    const io: typeof boundary.io = (...args) => {
        const url = typeof args[0] === 'string' ? new URL(args[0]) : null;
        const real = url?.hostname === '127.0.0.1' ? harness.allowRealServerSocketBoundary(url.origin) : null;
        try { return boundary.io(...args); } finally { real?.dispose(); }
    };
    return { ...boundary, io, connect: io, default: io };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const transport = vi.hoisted(() => ({ receive: null as null | ((method: string, payload: unknown) => Promise<unknown>) }));
// This is the Machine network boundary, not a filesystem or identity stub.
// Both HTTP Actions and metadata RPCs enter the real installed CLI receiver.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: { method: string; payload: unknown }) => {
        if (!transport.receive) throw new Error('No installed Machine transport');
        return transport.receive(request.method, request.payload);
    },
}));

afterEach(async () => {
    transport.receive = null;
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await homes.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('opens an owner Project file through the File-viewer, Account Action and installed Machine without a saved daemon Home descriptor', async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    const installed = await createInstalledFilesystemMachineFixture();
    const serverId = await homes.addHome({ name: 'Filesystem owner', serverUrl: installed.serverHttpBaseUrl,
        serverIdentityId: installed.homeServerIdentityId, accountId: 'requester', currentAccount: true });
    const root = join(installed.directory, 'project');
    await mkdir(join(root, 'src'), { recursive: true });
    const text = 'export const tideTable = [3, 7, 11];\n';
    await writeFile(join(root, 'src', 'tideTable.ts'), text);
    const received: string[] = [];
    transport.receive = async (method, payload) => {
        received.push(method);
        return installed.invoke(method, payload);
    };
    const actionId = 'daemon.filesystem.readFile';
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: installed.serverHttpBaseUrl,
        serverIdentityId: installed.homeServerIdentityId, accountId: 'requester', machineId: installed.machineId,
        actionId, tokenEpoch: 0,
        execute: async (input, context) => {
            expect(context.invocation).toMatchObject({ surface: 'ui', authority: 'present_user', caller: { kind: 'host' } });
            expect(context.target).toEqual({ kind: 'machine', machineId: installed.machineId });
            received.push(actionId);
            // This composed boundary opens the HTTP target and addresses that
            // exact installed Machine's semantic file RPC. It does not invent
            // a targeted-RPC wrapper unsupported by the incumbent reader.
            return installed.invoke(actionId, input, {
                callerAuthority: context.invocation.authority,
            });
        },
    });
    homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
    homes.answer(serverId, `/v1/machines/${installed.machineId}`, { body: { machine: boundary.machine } });
    for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
        homes.answer(serverId, path, { select: async (_input, request) => {
            const response = await boundary.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Unexpected filesystem Action HTTP');
            return { status: response.status, body: await response.json() };
        } });
    }
    const { storage } = await import('@/sync/domains/state/storage');
    const previous = storage.getState();
    const machine = createMachineFixture({ id: installed.machineId });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    try {
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await restoreConnectionToActiveServer({ token: homes.findByServerUrl(installed.serverHttpBaseUrl)!.token! });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { readOriginalAccountActionMachine } = await import('@/sync/api/externalActionAccountTransport');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            expect({ accountId: account.accountId, home: account.serverIdentityId }).toEqual({
                accountId: 'requester', home: installed.homeServerIdentityId,
            });
            expect(await readOriginalAccountActionMachine(account, machine.id)).toMatchObject({
                id: machine.id, kind: 'persistent', access: { custodian: { accountId: 'requester' }, accessState: 'ready' },
            });
        } finally { account.dispose(); }
        const { refreshWorkspaceFileDetails } = await import('@/components/workspaces/files/details/workspaceFileDetails/refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({ scope: { serverId, machineId: machine.id, rootPath: root },
            filePath: 'src/tideTable.ts', diffMode: 'both', includeDiff: false });
        expect(result, JSON.stringify({ received, homeChecks: installed.admissionChecks(),
            homePaths: homes.requests.map(request => request.path) })).toMatchObject({
            status: 'ready', error: null, fileContent: { content: text, isBinary: false },
        });
        expect(received).toContain('statFile');
        expect(received).toContain(actionId);
        expect(installed.admissionChecks()).toBeGreaterThan(0);
    } finally {
        storage.setState({ machines: previous.machines, machineListByServerId: previous.machineListByServerId });
    }
});
