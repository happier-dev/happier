import { afterEach, describe, expect, it, vi } from 'vitest';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const randomUUIDMock = vi.hoisted(() => vi.fn(() => 'ui-interaction-1'));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => randomUUIDMock(),
}));
describe('machinePluginInstallDecision', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        randomUUIDMock.mockClear();
        vi.restoreAllMocks();
    });

    it('creates affirmative interaction evidence at the UI transport boundary', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(42);
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'committed' });
        const { machinePluginInstallDecision } = await import('./machinePluginInstallDecision');

        await expect(machinePluginInstallDecision('machine-1', {
            isAuthorityCurrent: () => true,
            decision: {
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                confirmPresentUser: async () => [{ accessId: 'workspace', selected: false }],
            },
        })).resolves.toEqual({
            supported: true,
            outcome: { kind: 'committed', detail: null },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: {
                v: 1,
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                actorEvidence: {
                    kind: 'authenticatedLocalUser',
                    interactionId: 'ui-interaction-1',
                    occurredAtMs: 42,
                },
                optionalSelections: [{ accessId: 'workspace', selected: false }],
            },
        }));
    });

    it('turns a declined confirmation into cancellation without affirmative evidence', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'cancelled' });
        const { machinePluginInstallDecision } = await import('./machinePluginInstallDecision');

        await machinePluginInstallDecision('machine-1', {
            isAuthorityCurrent: () => true,
            decision: {
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                confirmPresentUser: async () => null,
            },
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: {
                v: 1,
                pendingChangeId: 'pending-1',
                decision: 'cancel',
            },
        }));
    });

    it('does not mint evidence or send a decision when authority changes while confirmation is open', async () => {
        let resolveConfirmation!: (selections: readonly Readonly<{ accessId: string; selected: boolean }>[]) => void;
        const confirmPresentUser = vi.fn(async () => await new Promise<
            readonly Readonly<{ accessId: string; selected: boolean }>[]
        >((resolve) => {
            resolveConfirmation = resolve;
        }));
        let authorityCurrent = true;
        const { machinePluginInstallDecision } = await import('./machinePluginInstallDecision');

        const resultPromise = machinePluginInstallDecision('machine-1', {
            isAuthorityCurrent: () => authorityCurrent,
            decision: {
                pendingChangeId: 'pending-1',
                decision: 'installAndTrust',
                confirmPresentUser,
            },
        });
        await vi.waitFor(() => expect(confirmPresentUser).toHaveBeenCalledOnce());
        authorityCurrent = false;
        resolveConfirmation([]);

        await expect(resultPromise).resolves.toEqual({ supported: false, reason: 'error' });
        expect(randomUUIDMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    });
});
