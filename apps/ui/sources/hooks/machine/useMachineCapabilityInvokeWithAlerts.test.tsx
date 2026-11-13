import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { Modal } from '@/modal';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let reply: () => CapabilitiesInvokeResponse | Promise<CapabilitiesInvokeResponse>;
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installSessionActionRpcBoundary(request => request.method.endsWith(RPC_METHODS.CAPABILITIES_INVOKE) ? reply() : {});
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { useMachineCapabilityInvokeWithAlerts } = await import('./useMachineCapabilityInvokeWithAlerts');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const alerts = { errorTitle: 'Error', successTitle: 'Success', successMessage: 'Packed', unsupportedMessage: () => 'Unavailable' };
const packRequest = { id: 'tool.plugins' as const, method: 'pack', params: { pluginId: 'example.plugin' } };
const packed = { ok: true, result: { action: 'pack' } } satisfies CapabilitiesInvokeResponse;

describe('useMachineCapabilityInvokeWithAlerts', () => {
    beforeEach(async () => {
        vi.mocked(Modal.alert).mockClear();
        reply = () => packed;
        serverId = await homes.addHome({ name: 'Capability alerts', serverUrl: 'https://capability-alerts.test', accountId: 'account-a' });
        homes.answer(serverId, '/v1/machines/machine-1', { body: { machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }) } });
        account = await restoreServerAccountForTest({ serverUrl: 'https://capability-alerts.test', accountId: 'account-a', request: homes.request });
        installHomeGovernanceBoundaries(homes);
    });
    afterEach(async () => {
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool')).serverScopedRpcSocketPool.resetForTests();
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool')).resetScopedMachineTransportCacheForTests();
        await account?.dispose();
        account = undefined;
        await homes.reset();
        vi.restoreAllMocks();
    });

    it('returns the intermediate review result silently and announces a current completion', async () => {
        const review = { ok: true, result: { change: {
            kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null,
            authorityExpansion: [], pendingChangeId: 'pending-1',
        } } } satisfies CapabilitiesInvokeResponse;
        reply = () => review;
        const hook = await renderHook(() => useMachineCapabilityInvokeWithAlerts());
        try {
            await act(async () => {
                expect(await hook.getCurrent().invokeWithAlerts({ machineId: 'machine-1', serverId,
                    request: { id: 'tool.plugins', method: 'install', params: { pluginId: 'example.plugin', sourceId: 'marketplace:community-npm' } },
                    alerts: { ...alerts, successMessage: null },
                })).toEqual({ supported: true, response: review });
            });
            expect(Modal.alert).not.toHaveBeenCalled();
            reply = () => packed;
            await act(async () => {
                expect(await hook.getCurrent().invokeWithAlerts({ machineId: 'machine-1', serverId,
                    request: packRequest, alerts,
                })).toEqual({ supported: true, response: packed });
            });
            expect(Modal.alert).toHaveBeenCalledWith('Success', 'Packed');
            expect(hook.getCurrent().isInvoking).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('returns a settled result without announcing completion after caller authority retires in flight', async () => {
        let current = true;
        let settle!: (response: CapabilitiesInvokeResponse) => void;
        let received = false;
        const pending = new Promise<CapabilitiesInvokeResponse>(resolve => { settle = resolve; });
        reply = () => { received = true; return pending; };
        const hook = await renderHook(() => useMachineCapabilityInvokeWithAlerts());
        try {
            let invocation!: ReturnType<ReturnType<typeof useMachineCapabilityInvokeWithAlerts>['invokeWithAlerts']>;
            await act(async () => {
                invocation = hook.getCurrent().invokeWithAlerts({ machineId: 'machine-1', serverId,
                    request: packRequest, isAuthorityCurrent: () => current, alerts });
            });
            await vi.waitFor(() => expect(received).toBe(true));
            current = false;
            await act(async () => {
                settle(packed);
                expect(await invocation).toEqual({ supported: true, response: packed });
            });
            expect(Modal.alert).not.toHaveBeenCalled();
            expect(hook.getCurrent().isInvoking).toBe(false);
        } finally { settle(packed); await hook.unmount(); }
    });

    it.each(['an explicit outcome-unknown response', 'commit-intended transport loss'] as const)(
        'returns %s for caller reconciliation and alerts when deferral is disabled', async label => {
            const uncertain = { ok: false, error: { code: 'outcomeUnknown', message: 'Commit outcome is unknown' } } satisfies CapabilitiesInvokeResponse;
            const transportLoss = label === 'commit-intended transport loss';
            reply = () => {
                if (transportLoss) throw new Error('Connection closed after send');
                return uncertain;
            };
            const expected = transportLoss
                ? { supported: false, reason: 'error', requestDisposition: 'outcomeUnknown' }
                : { supported: true, response: uncertain };
            const hook = await renderHook(() => useMachineCapabilityInvokeWithAlerts());
            try {
                for (const deferAmbiguousOutcomeToCaller of [true, false]) {
                    await act(async () => {
                        expect(await hook.getCurrent().invokeWithAlerts({ machineId: 'machine-1', serverId,
                            request: { id: 'tool.plugins', method: 'uninstall', params: { pluginId: 'example.plugin' } },
                            alerts: { ...alerts, successMessage: null, deferAmbiguousOutcomeToCaller },
                        })).toEqual(expected);
                    });
                    if (deferAmbiguousOutcomeToCaller) expect(Modal.alert).not.toHaveBeenCalled();
                    else expect(Modal.alert).toHaveBeenCalledWith('Error', transportLoss ? 'Unavailable' : uncertain.error.message);
                }
            } finally { await hook.unmount(); }
        },
    );
});
