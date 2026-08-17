import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const runControlMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: 'server-a',
        generation: 3,
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [{
        id: 'machine-a',
        active: true,
    }],
}));

vi.mock('@/sync/ops/connectedAccounts/connectedAccountDaemon', () => ({
    runConnectedAccountControlCommand: runControlMock,
}));

describe('useConnectedServiceLegacyOperationAdmission', () => {
    beforeEach(() => {
        runControlMock.mockReset();
    });

    it('carries the qualified identity and requested operation to daemon admission', async () => {
        runControlMock.mockResolvedValue({
            status: 'described',
            service: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github-account',
            },
            operationTransport: {
                kind: 'legacy',
                peerClass: 'revisioned_v2_v3',
                serviceId: 'github',
            },
        });
        const { useConnectedServiceLegacyOperationAdmission } = await import(
            './useConnectedServiceLegacyOperationAdmission'
        );
        const hook = await renderHook(
            () => useConnectedServiceLegacyOperationAdmission(),
        );

        await act(async () => {
            await hook.getCurrent()('github', 'quota_refresh');
        });

        expect(runControlMock).toHaveBeenCalledWith({
            serverId: 'server-a',
            machineId: 'machine-a',
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 3,
            },
            command: {
                operation: 'describeService',
                service: {
                    pluginId: 'happier.scm.forge.github',
                    localId: 'github-account',
                },
                requiredOperation: 'quota_refresh',
            },
        });
        await standardCleanup();
    });

    it('rejects unsupported and non-legacy transports before a quota caller can issue network effects', async () => {
        runControlMock.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'connected_account_service_identity_unsupported',
        });
        const { useConnectedServiceLegacyOperationAdmission } = await import(
            './useConnectedServiceLegacyOperationAdmission'
        );
        const hook = await renderHook(
            () => useConnectedServiceLegacyOperationAdmission(),
        );

        await expect(
            hook.getCurrent()('bitbucket', 'quota_read'),
        ).rejects.toMatchObject({
            code: 'connected_account_service_identity_unsupported',
        });
        runControlMock.mockResolvedValueOnce({
            status: 'described',
            service: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github-account',
            },
            operationTransport: { kind: 'v4' },
        });
        await expect(
            hook.getCurrent()('github', 'quota_read'),
        ).rejects.toMatchObject({
            code: 'connected_account_legacy_operation_unsupported',
        });
        await standardCleanup();
    });

    it('admits the exact qualified V4 service only when the daemon selects V4', async () => {
        runControlMock.mockResolvedValue({
            status: 'described',
            service: {
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
            },
            operationTransport: { kind: 'v4' },
        });
        const { useConnectedAccountOperationAdmission } = await import(
            './useConnectedServiceLegacyOperationAdmission'
        );
        const hook = await renderHook(
            () => useConnectedAccountOperationAdmission(),
        );

        await act(async () => {
            await hook.getCurrent()(
                {
                    pluginId: 'happier.agent.claude',
                    localId: 'anthropic',
                },
                { kind: 'v4' },
                'quota_read',
            );
        });

        expect(runControlMock).toHaveBeenCalledWith({
            serverId: 'server-a',
            machineId: 'machine-a',
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 3,
            },
            command: {
                operation: 'describeService',
                service: {
                    pluginId: 'happier.agent.claude',
                    localId: 'anthropic',
                },
                requiredOperation: 'quota_read',
            },
        });
        await standardCleanup();
    });

    it('rejects a contradictory exact-old daemon transport for a V4 operation', async () => {
        runControlMock.mockResolvedValue({
            status: 'described',
            service: {
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
            },
            operationTransport: {
                kind: 'legacy',
                peerClass: 'exact_v0_2_1',
                serviceId: 'anthropic',
            },
        });
        const { useConnectedAccountOperationAdmission } = await import(
            './useConnectedServiceLegacyOperationAdmission'
        );
        const hook = await renderHook(
            () => useConnectedAccountOperationAdmission(),
        );

        await expect(hook.getCurrent()(
            {
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
            },
            { kind: 'v4' },
            'quota_read',
        )).rejects.toMatchObject({
            code: 'connected_account_v4_operation_unsupported',
        });
        await standardCleanup();
    });
});
