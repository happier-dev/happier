import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const confirmSpy = vi.hoisted(() => vi.fn());
const alertSpy = vi.hoisted(() => vi.fn());
const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
const commitSelectionSpy = vi.hoisted(() => vi.fn());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmSpy, alert: alertSpy } }).module;
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));
const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const confirmation = {
    kind: 'confirm-experimental',
    connectionId: ProviderConnectionIdSchema.parse('pc_experimental'),
    expectedConnectionRevision: 3,
    agentTargetKey: 'agent:happier.agent.codex/codex',
    modelId: 'experimental-model',
    compatibilityFingerprint: 'compatibility:v1:experimental',
    providerName: 'Gateway',
    modelName: 'Experimental model',
} as const;

// Warm the real Sync module after the transport leaves are installed, not inside a test hook's budget.
await loadSyncSingletonForTests();

describe('useConfirmExperimentalProviderModel', () => {
    beforeEach(async () => {
        confirmSpy.mockReset();
        alertSpy.mockReset();
        machineRpcWithServerScope.mockReset();
        commitSelectionSpy.mockReset();
        serverId = (await account.restore({ waivedActions: ['providers.models.experimental.confirm'] })).serverId;
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test', accountId: 'account-a', active: false });
    });
    afterEach(async () => { standardCleanup(); await account.reset(); });

    it('keeps authoring pending until the confirmed selection is committed', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const mutationResult = createDeferred<{ status: 'success'; action: 'confirmExperimental' }>();
        machineRpcWithServerScope.mockReturnValueOnce(mutationResult.promise);
        const refresh = vi.fn(async () => {});
        const commitSelection = vi.fn();
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        let confirmationResult: Promise<boolean> | null = null;
        await act(async () => {
            confirmationResult = hook.getCurrent().confirm(confirmation, commitSelection);
            await Promise.resolve();
        });

        expect(hook.getCurrent().pending).toBe(true);
        expect(commitSelection).not.toHaveBeenCalled();

        await act(async () => {
            mutationResult.resolve({ status: 'success', action: 'confirmExperimental' });
            await confirmationResult;
        });

        expect(commitSelection).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(hook.getCurrent().pending).toBe(false);
    });

    it('does not mutate the old machine after the scope changes while confirmation is open', async () => {
        const modalResult = createDeferred<boolean>();
        confirmSpy.mockReturnValueOnce(modalResult.promise);
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { machineId: string; serverId: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: props.machineId,
                serverId: props.serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh,
            }),
            { initialProps: { machineId: 'machine-a', serverId } },
        );

        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await hook.rerender({ machineId: 'machine-b', serverId: otherServerId });
        await act(async () => modalResult.resolve(true));

        await expect(pending).resolves.toBe(false);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('does not dispatch Account A confirmation after Account B mounts with identical routing ids', async () => {
        const modalResult = createDeferred<boolean>();
        confirmSpy.mockReturnValueOnce(modalResult.promise);
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        let pending!: Promise<boolean>;
        act(() => { pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy); });
        await act(async () => {
            await account.restore({ accountId: 'account-b' });
            await hook.rerender();
        });
        await act(async () => modalResult.resolve(true));

        await expect(pending).resolves.toBe(false);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().pending).toBe(false);
    });

    it('does not mutate after the exact Agent target scope changes while confirmation is open', async () => {
        const modalResult = createDeferred<boolean>();
        confirmSpy.mockReturnValueOnce(modalResult.promise);
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'success', action: 'confirmExperimental' });
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { agentTargetKey: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: 'machine-a',
                serverId,
                agentTargetKey: props.agentTargetKey,
                refresh,
            }),
            { initialProps: { agentTargetKey: 'agent:happier.agent.codex/codex' } },
        );

        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await hook.rerender({ agentTargetKey: 'agent:happier.agent.claude/claude' });
        await act(async () => modalResult.resolve(true));

        await expect(pending).resolves.toBe(false);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('does not mutate after the Providers feature is disabled while confirmation is open', async () => {
        const modalResult = createDeferred<boolean>();
        confirmSpy.mockReturnValueOnce(modalResult.promise);
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'success', action: 'confirmExperimental' });
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { enabled: boolean }) => useConfirmExperimentalProviderModel({
                enabled: props.enabled,
                machineId: 'machine-a',
                serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh,
            }),
            { initialProps: { enabled: true } },
        );

        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await hook.rerender({ enabled: false });
        await act(async () => modalResult.resolve(true));

        await expect(pending).resolves.toBe(false);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().retry).toBeNull();
    });

    it('does not refresh or select the old scope after an in-flight mutation crosses a scope change', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const mutationResult = createDeferred<{ status: 'success' }>();
        machineRpcWithServerScope.mockReturnValueOnce(mutationResult.promise);
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { machineId: string; serverId: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: props.machineId,
                serverId: props.serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh,
            }),
            { initialProps: { machineId: 'machine-a', serverId } },
        );

        let pending!: Promise<boolean>;
        act(() => {
            pending = hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        await waitForHomeGovernance(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1));
        await hook.rerender({ machineId: 'machine-b', serverId: otherServerId });
        await act(async () => mutationResult.resolve({ status: 'success' }));

        await expect(pending).resolves.toBe(false);
        expect(refresh).not.toHaveBeenCalled();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('exposes an exact typed daemon failure to the picker instead of flattening it into a modal', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        const expectedError = createProviderErrorV1('provider_authorization_changed', {
            connectionId: confirmation.connectionId,
            machineId: 'machine-a',
        });
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'error', error: expectedError });
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh: vi.fn(async () => {}),
        }));

        await act(async () => {
            await expect(hook.getCurrent().confirm(confirmation, commitSelectionSpy)).resolves.toBe(false);
        });

        expect(hook.getCurrent().error).toEqual(expectedError);
        expect(hook.getCurrent().retry).toBeTypeOf('function');
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('reconciles a commit-then-reject outcome and never exposes the stored mutation for replay', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        machineRpcWithServerScope.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
        const refresh = vi.fn(async () => {});
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        await act(async () => {
            await expect(hook.getCurrent().confirm(confirmation, commitSelectionSpy)).resolves.toBe(false);
        });
        expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
            connectionId: confirmation.connectionId,
            machineId: 'machine-a',
        }));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(commitSelectionSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().error?.action).toBe('review_current_state');
        expect(hook.getCurrent().retry).toBeNull();
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('does not repeat a successful confirmation mutation when only the presentation refresh fails', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        machineRpcWithServerScope.mockResolvedValueOnce({ status: 'success', action: 'confirmExperimental' });
        const refresh = vi.fn(async () => { throw new Error('refresh failed'); });
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh,
        }));

        await act(async () => {
            await expect(hook.getCurrent().confirm(confirmation, commitSelectionSpy)).resolves.toBe(true);
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(commitSelectionSpy).toHaveBeenCalledOnce();
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().retry).toBeNull();
    });

    it('refuses a captured retry after the machine/server scope changes', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_authorization_changed', {
                connectionId: confirmation.connectionId,
                machineId: 'machine-a',
            }),
        });
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(
            (props: { machineId: string; serverId: string }) => useConfirmExperimentalProviderModel({
                enabled: true,
                machineId: props.machineId,
                serverId: props.serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex',
                refresh: vi.fn(async () => {}),
            }),
            { initialProps: { machineId: 'machine-a', serverId } },
        );
        await act(async () => {
            await hook.getCurrent().confirm(confirmation, commitSelectionSpy);
        });
        const capturedRetry = hook.getCurrent().retry;
        expect(capturedRetry).toBeTypeOf('function');

        await hook.rerender({ machineId: 'machine-b', serverId: otherServerId });
        await act(async () => {
            await expect(capturedRetry?.()).resolves.toBe(false);
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
    });

    it('clears a previous failure when a new confirmation attempt is cancelled', async () => {
        confirmSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        machineRpcWithServerScope.mockResolvedValueOnce({
            status: 'error',
            error: createProviderErrorV1('provider_authorization_changed', {
                connectionId: confirmation.connectionId,
                machineId: 'machine-a',
            }),
        });
        const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            refresh: vi.fn(async () => {}),
        }));
        await act(async () => { await hook.getCurrent().confirm(confirmation, commitSelectionSpy); });
        expect(hook.getCurrent().error).not.toBeNull();

        await act(async () => { await hook.getCurrent().confirm(confirmation, commitSelectionSpy); });

        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().retry).toBeNull();
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
    });
});
