import { renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const materializeStartSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionMaterializeStart: materializeStartSpy,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { alert: modalAlertSpy },
    }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'materialize-idempotency-1',
}));

type MaterializeHook =
    typeof import('./useExternalSessionMaterialize')['useExternalSessionMaterialize'];
type Runtime = Parameters<MaterializeHook>[0]['externalSessionRuntime'];

const externalSessionLink: NonNullable<Runtime['externalSessionLink']> = {
    v: 1,
    agentId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: 'vendor-session-1',
    source: { kind: 'codexHome', home: 'user' },
    linkedAtMs: 1_000,
};
const onlineStatus: NonNullable<Runtime['status']> = {
    ok: true,
    machineOnline: true,
    runnerActive: true,
    activity: 'running',
    canTakeOverDirect: false,
    canTakeOverPersist: false,
    canForceStop: false,
};

async function renderHarness(runtime: Runtime, hasWriteAccess = true) {
    const { useExternalSessionMaterialize } = await import('./useExternalSessionMaterialize');
    return await renderHook(
        (input: { runtime: Runtime; hasWriteAccess: boolean }) =>
            useExternalSessionMaterialize({
                sessionId: 'session-1',
                hasWriteAccess: input.hasWriteAccess,
                externalSessionRuntime: input.runtime,
            }),
        {
            initialProps: { runtime, hasWriteAccess },
        },
    );
}

describe('useExternalSessionMaterialize', () => {
    beforeEach(() => {
        materializeStartSpy.mockReset();
        materializeStartSpy.mockResolvedValue({
            ok: true,
            progress: { operationId: 'operation-1' },
        });
        modalAlertSpy.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('starts materialization with public intent only on the owning session server', async () => {
        const refreshNow = vi.fn(async () => onlineStatus);
        const harness = await renderHarness({
            externalSessionLink,
            status: onlineStatus,
            refreshNow,
            sessionServerId: 'server-owned',
        });

        await act(async () => {
            await harness.getCurrent().requestMaterialize();
        });

        expect(materializeStartSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            request: {
                v: 1,
                idempotencyKey: 'materialize-idempotency-1',
                sessionId: 'session-1',
                plan: 'materialize',
                targetStorageMode: 'external-linked',
                targetRuntimeMode: null,
            },
        }, { serverId: 'server-owned' });
        expect(materializeStartSpy.mock.calls[0]?.[0]?.request)
            .not.toHaveProperty('source');
        await harness.unmount();
    });

    it('fails closed while the current source machine is offline', async () => {
        const offlineStatus = { ...onlineStatus, machineOnline: false };
        const refreshNow = vi.fn(async () => offlineStatus);
        const harness = await renderHarness({
            externalSessionLink,
            status: onlineStatus,
            refreshNow,
            sessionServerId: 'server-owned',
        });

        let result = true;
        await act(async () => {
            result = await harness.getCurrent().requestMaterialize();
        });

        expect(result).toBe(false);
        expect(materializeStartSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'chatFooter.externalSessionMachineOffline',
        );
        await harness.unmount();
    });

    it('presents typed safe action copy and retains the idempotency key for retry', async () => {
        const refreshNow = vi.fn(async () => onlineStatus);
        materializeStartSpy
            .mockResolvedValueOnce({
                ok: false,
                error: {
                    code: 'operation_conflict',
                    message: 'daemon-private-operation-detail',
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                progress: { operationId: 'operation-1' },
            });
        const harness = await renderHarness({
            externalSessionLink,
            status: onlineStatus,
            refreshNow,
            sessionServerId: 'server-owned',
        });

        await act(async () => {
            await harness.getCurrent().requestMaterialize();
            await harness.getCurrent().requestMaterialize();
        });

        expect(materializeStartSpy).toHaveBeenCalledTimes(2);
        expect(materializeStartSpy.mock.calls[0]?.[0]?.request.idempotencyKey)
            .toBe('materialize-idempotency-1');
        expect(materializeStartSpy.mock.calls[1]?.[0]?.request.idempotencyKey)
            .toBe('materialize-idempotency-1');
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'externalSessions.operationActionErrorConflict',
        );
        expect(modalAlertSpy).not.toHaveBeenCalledWith(
            expect.anything(),
            'daemon-private-operation-detail',
        );
        await harness.unmount();
    });
});
