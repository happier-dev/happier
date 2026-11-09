import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BugReportMachineDiagnosticsSnapshotSchema } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machines ops server-scoped routing', () => {
    const initialStorageState = storage.getInitialState();
    const machine: Machine = {
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        revokedAt: null,
        metadata: {
            host: 'test-machine',
            platform: 'darwin',
            happyCliVersion: '0.2.0',
            happyHomeDir: '/Users/alice/.happier',
            homeDir: '/Users/alice',
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };

    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        storage.setState({
            ...initialStorageState,
            profileScope: { serverId: 'server-b', accountId: 'account-a' },
            machines: { 'machine-1': machine },
        }, true);
        getPersistenceStorage().clearAll();
    });

    it('routes preview env through server-scoped rpc with the requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            policy: 'none',
            values: {},
        });
        const { machinePreviewEnv } = await import('./machines');

        const result = await machinePreviewEnv(
            'machine-2',
            { keys: ['FOO'] },
            { serverId: 'server-c' },
        );

        expect(result).toEqual({
            supported: true,
            response: {
                policy: 'none',
                values: {},
            },
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-2',
            serverId: 'server-c',
        }));
    });

    it('routes bash through server-scoped rpc with the requested server id', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
        });
        const { machineBash } = await import('./machines');

        const result = await machineBash(
            'machine-3',
            'echo ok',
            '/',
            { serverId: 'server-d' },
        );

        expect(result).toEqual({
            success: true,
            stdout: 'ok',
            stderr: '',
            exitCode: 0,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-3',
            serverId: 'server-d',
            method: 'bash',
        }));
    });

    it('routes bug-report diagnostics through server-scoped rpc with the requested server id', async () => {
        const snapshot = BugReportMachineDiagnosticsSnapshotSchema.parse({
            daemonState: null,
            daemonLogs: [],
            doctorSnapshot: {
                capturedAt: '2026-04-07T10:11:12.000Z',
                server: { activeServerId: 'server-e', serverUrl: 'https://server-e',
                    publicServerUrl: 'https://server-e', webappUrl: 'https://server-e' },
                accountId: 'account-a',
                settings: { activeServerId: 'server-e', servers: [], knownAccountIds: ['account-a'] },
            },
            runtime: { cwd: '/repo', platform: 'darwin', nodeVersion: 'test-runtime' },
            stackContext: null,
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce(snapshot);
        const { machineCollectBugReportDiagnostics } = await import('./machines');

        const result = await machineCollectBugReportDiagnostics('machine-4', {
            serverId: 'server-e',
            timeoutMs: 2500,
        });

        expect(result).toEqual(snapshot);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-4',
            serverId: 'server-e',
            timeoutMs: 2500,
            method: 'bugreport.collectDiagnostics',
        }));
    });
});
