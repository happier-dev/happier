import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { presentSessionProviderBinding } from '@/providers/session/presentation';

const describeProviderBindingStatus = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: Readonly<{ payload: unknown }>) => describeProviderBindingStatus(request.payload, request),
}));
const account = createProviderSettingsAccountHarness();
let serverId = '';

const { useProviderBindingStatus } = await import('./useProviderBindingStatus');

describe('useProviderBindingStatus', () => {
    beforeEach(async () => {
        describeProviderBindingStatus.mockReset();
        serverId = (await account.restore()).serverId;
    });
    afterEach(async () => {
        standardCleanup();
        await account.reset();
    });

    const launchBinding = {
        v: 1 as const, connectionId: ProviderConnectionIdSchema.parse('pc_launch'), contributionKey: null, connectionRevision: 1,
        protocol: 'openai-responses' as const, materialization: 'engineConfig' as const,
        compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
        displaySnapshot: { providerName: 'Gateway', connectionName: 'Launch', connectionRole: 'named' as const,
            connectionDisplayNameMode: 'custom' as const },
    };
    const selection = {
        v: 1 as const, updatedAt: 2,
        ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: launchBinding.connectionId, modelId: 'next' },
    };
    function useBindingPresentation() {
        const result = useProviderBindingStatus({ enabled: true, machineId: 'machine-a', serverId, selection, launchBinding });
        return { ...result, banner: presentSessionProviderBinding({ binding: launchBinding, status: result.status, error: result.error }).banner };
    }

    it('keeps the banner absent throughout a successful current read on the Session Home', async () => {
        serverId = await account.addHome({ name: 'Session Home', serverUrl: 'https://provider-binding-peer.test',
            serverIdentityId: 'srv_binding_peer', accountId: 'peer-session', currentAccount: true, active: false });
        describeProviderBindingStatus.mockResolvedValue({ status: 'current' });
        const banners: unknown[] = [];
        const rendered = await renderHook(() => {
            const result = useBindingPresentation();
            banners.push(result.banner);
            return result;
        });
        expect(rendered.getCurrent()).toMatchObject({ status: { status: 'current' }, error: null, loading: false, banner: null });
        expect(banners.every(banner => banner === null)).toBe(true);
        expect(describeProviderBindingStatus).toHaveBeenLastCalledWith(
            { machineId: 'machine-a', agentTargetKey: selection.ref.agentTargetKey, selection, launchBinding },
            expect.objectContaining({ serverId: 'srv_binding_peer', accountId: 'peer-session', machineId: 'machine-a', method: 'daemon.providers.binding.status' }),
        );
    });

    it('presents a typed daemon deadline as unanswered and clears it after a successful retry', async () => {
        describeProviderBindingStatus.mockResolvedValueOnce({
            error: 'RPC request timed out', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE,
        }).mockResolvedValueOnce({ status: 'current' });
        const rendered = await renderHook(useBindingPresentation);
        expect(rendered.getCurrent()).toMatchObject({ loading: false,
            error: { code: 'agent_timeout', retryable: true, action: 'retry' },
            banner: { kind: 'status-error', action: 'retry', errorPresentation: {
                titleKey: 'settingsProviders.errors.machineTimeoutTitle',
            } },
        });
        await act(async () => { await rendered.getCurrent().refresh(); });
        expect(rendered.getCurrent()).toMatchObject({ status: { status: 'current' }, error: null, banner: null });
    });

    it.each([false, true])('retains the typed failure until retry settles (persistent failure: %s)', async persistent => {
        const failure = createProviderErrorV1('provider_catalog_unavailable', { connectionId: 'pc_launch', machineId: 'machine-a' });
        let settle!: () => void;
        const retry = new Promise<{ status: 'current' }>((resolve, reject) => {
            settle = () => persistent ? reject(failure) : resolve({ status: 'current' });
        });
        // Only the Machine Action transport is mocked; Action dispatch, error parsing,
        // mounted read custody and banner presentation all run their production logic.
        describeProviderBindingStatus.mockRejectedValueOnce(failure).mockReturnValueOnce(retry);
        const rendered = await renderHook(useBindingPresentation);
        expect(rendered.getCurrent()).toMatchObject({ status: null, error: failure, loading: false,
            banner: { kind: 'status-error', action: 'retry' } });
        let refresh!: Promise<void>;
        await act(async () => { refresh = rendered.getCurrent().refresh(); });
        expect(rendered.getCurrent()).toMatchObject({ error: failure, loading: true,
            banner: { kind: 'status-error', action: 'retry' } });
        await act(async () => { settle(); await refresh; });
        expect(rendered.getCurrent()).toMatchObject(persistent
            ? { status: null, error: failure, loading: false, banner: { kind: 'status-error', action: 'retry' } }
            : { status: { status: 'current' }, error: null, loading: false, banner: null });
    });

    it('offers Retry for a settled catalog failure and clears it after a current binding read', async () => {
        const failure = createProviderErrorV1('provider_catalog_unavailable', { connectionId: 'pc_launch', machineId: 'machine-a' });
        describeProviderBindingStatus.mockResolvedValueOnce({ status: 'incompatible', error: failure })
            .mockResolvedValueOnce({ status: 'current' });
        const rendered = await renderHook(useBindingPresentation);
        expect(rendered.getCurrent()).toMatchObject({ status: { status: 'incompatible', error: failure }, loading: false,
            banner: { kind: 'status-error', action: 'retry' } });
        await act(async () => { await rendered.getCurrent().refresh(); });
        expect(rendered.getCurrent()).toMatchObject({ status: { status: 'current' }, error: null, loading: false, banner: null });
    });

    it.each([false, true])('rechecks attention after a completed turn without hiding an unresolved binding failure (persistent: %s)', async persistent => {
        const failure = createProviderErrorV1('provider_catalog_unavailable', { connectionId: 'pc_launch', machineId: 'machine-a' });
        let settle!: () => void;
        const recoveredRead = new Promise<unknown>(resolve => {
            settle = () => resolve(persistent ? { status: 'incompatible', error: failure } : { status: 'current' });
        });
        describeProviderBindingStatus.mockResolvedValueOnce({ status: 'incompatible', error: failure })
            .mockReturnValueOnce(recoveredRead);
        const rendered = await renderHook(({ completedTurnObservedAt }: { completedTurnObservedAt: number | null }) => {
            const result = useProviderBindingStatus({ enabled: true, machineId: 'machine-a', serverId,
                selection, launchBinding, completedTurnObservedAt });
            return { ...result, banner: presentSessionProviderBinding({ binding: launchBinding, status: result.status, error: result.error }).banner };
        }, { initialProps: { completedTurnObservedAt: 99 as number | null } });
        expect(rendered.getCurrent()).toMatchObject({ loading: false, banner: { kind: 'status-error', action: 'retry' } });
        await rendered.rerender({ completedTurnObservedAt: null });
        expect(rendered.getCurrent()).toMatchObject({ loading: false, banner: { kind: 'status-error', action: 'retry' } });
        await rendered.rerender({ completedTurnObservedAt: 100 });
        expect(rendered.getCurrent()).toMatchObject({ loading: true, banner: { kind: 'status-error', action: 'retry' } });
        await act(async () => { settle(); });
        expect(rendered.getCurrent()).toMatchObject(persistent
            ? { loading: false, banner: { kind: 'status-error', action: 'retry' } }
            : { loading: false, status: { status: 'current' }, banner: null });
        await rendered.rerender({ completedTurnObservedAt: 100 });
        expect(rendered.getCurrent().loading).toBe(false);
        expect(describeProviderBindingStatus).toHaveBeenCalledTimes(2);
    });

    it('rechecks a current binding once per pushed binding refusal and retains current until the read settles', async () => {
        let settle!: () => void;
        const changedRead = new Promise<unknown>(resolve => {
            settle = () => resolve({ status: 'changed', nextBindingSecurityFingerprint: 'binding-security:v1:next' });
        });
        describeProviderBindingStatus.mockResolvedValueOnce({ status: 'current' }).mockReturnValueOnce(changedRead);
        const rendered = await renderHook(({ bindingRefusalObservedAt }: { bindingRefusalObservedAt: number | null }) =>
            useProviderBindingStatus({ enabled: true, machineId: 'machine-a', serverId,
                selection, launchBinding, bindingRefusalObservedAt }),
        { initialProps: { bindingRefusalObservedAt: null as number | null } });
        expect(rendered.getCurrent().status).toEqual({ status: 'current' });
        const initialReads = describeProviderBindingStatus.mock.calls.length;
        await rendered.rerender({ bindingRefusalObservedAt: 100 });
        expect(rendered.getCurrent()).toMatchObject({ status: { status: 'current' }, loading: true });
        expect(describeProviderBindingStatus.mock.calls.length - initialReads).toBe(1);
        await rendered.rerender({ bindingRefusalObservedAt: 100 });
        expect(describeProviderBindingStatus.mock.calls.length - initialReads).toBe(1);
        await act(async () => { settle(); });
        expect(rendered.getCurrent()).toMatchObject({ loading: false,
            status: { status: 'changed', nextBindingSecurityFingerprint: 'binding-security:v1:next' } });
        await rendered.rerender({ bindingRefusalObservedAt: 100 });
        expect(describeProviderBindingStatus.mock.calls.length - initialReads).toBe(1);
    });

    it('clears a successful binding status immediately when its machine scope changes', async () => {
        let resolveB!: (value: unknown) => void;
        describeProviderBindingStatus
            .mockResolvedValueOnce({ status: 'current' })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const value: { current: ReturnType<typeof useProviderBindingStatus> | null } = { current: null };
        const selection = {
            v: 1 as const, updatedAt: 2,
            ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_launch'), modelId: 'next' },
        };
        const launchBinding = {
            v: 1 as const, connectionId: ProviderConnectionIdSchema.parse('pc_launch'), contributionKey: null, connectionRevision: 1,
            protocol: 'openai-responses' as const, materialization: 'engineConfig' as const,
            compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
            displaySnapshot: { providerName: 'Gateway', connectionName: 'Launch', connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const },
        };
        function Harness(props: { machineId: string }) {
            value.current = useProviderBindingStatus({
                enabled: true, machineId: props.machineId, serverId, selection, launchBinding,
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(<Harness machineId="machine-a" />);
        await act(async () => {});
        expect(value.current?.status).toEqual({ status: 'current' });
        await screen.update(<Harness machineId="machine-b" />);
        expect(value.current?.status).toBeNull();
        await act(async () => resolveB({ status: 'current' }));
    });

    it('clears Account A, rejects its late status, and starts one Account B read when routing ids stay equal', async () => {
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        describeProviderBindingStatus
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const value: { current: ReturnType<typeof useProviderBindingStatus> | null } = { current: null };
        const selection = {
            v: 1 as const,
            updatedAt: 2,
            ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: ProviderConnectionIdSchema.parse('pc_launch'),
                modelId: 'next',
            },
        };
        const launchBinding = {
            v: 1 as const,
            connectionId: ProviderConnectionIdSchema.parse('pc_launch'),
            contributionKey: null,
            connectionRevision: 1,
            protocol: 'openai-responses' as const,
            materialization: 'engineConfig' as const,
            compatibilityFingerprint: 'compatibility:v1:a',
            bindingSecurityFingerprint: 'binding-security:v1:a',
            displaySnapshot: {
                providerName: 'Gateway', connectionName: 'Launch', connectionRole: 'named' as const,
                connectionDisplayNameMode: 'custom' as const,
            },
        };
        function Harness() {
            value.current = useProviderBindingStatus({
                enabled: true, machineId: 'machine-a', serverId, selection, launchBinding,
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(<Harness />);
        expect(describeProviderBindingStatus).toHaveBeenCalledTimes(1);

        await act(async () => {
            await account.restore({ accountId: 'account-b' });
            await screen.update(<Harness />);
        });

        expect(value.current?.status).toBeNull();
        await act(async () => {});
        expect(describeProviderBindingStatus).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveA({ status: 'changed', nextBindingSecurityFingerprint: 'binding-security:v1:stale' });
        });
        expect(value.current?.status).toBeNull();

        await act(async () => {
            resolveB({ status: 'current' });
        });
        expect(value.current?.status).toEqual({ status: 'current' });
    });

    it('does not call the daemon without one exact provider-bound launch tuple', async () => {
        function Harness() {
            useProviderBindingStatus({ enabled: true, machineId: 'machine-a', serverId, selection: null, launchBinding: null });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => {});
        expect(describeProviderBindingStatus).not.toHaveBeenCalled();
    });

    it('classifies a connection switch as changed without sending an invalid launch tuple', async () => {
        const value: { current: ReturnType<typeof useProviderBindingStatus> | null } = { current: null };
        function Harness() {
            value.current = useProviderBindingStatus({
                enabled: true, machineId: 'machine-a', serverId,
                selection: {
                    v: 1, updatedAt: 2,
                    ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_next'), modelId: 'next' },
                },
                launchBinding: {
                    v: 1, connectionId: ProviderConnectionIdSchema.parse('pc_launch'), contributionKey: null, connectionRevision: 1,
                    protocol: 'openai-responses', materialization: 'engineConfig',
                    compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
                    displaySnapshot: {
                        providerName: 'Gateway', connectionName: 'Launch', connectionRole: 'named', connectionDisplayNameMode: 'custom',
                    },
                },
            });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => {});
        expect(value.current?.status).toEqual({ status: 'selection_changed' });
        expect(describeProviderBindingStatus).not.toHaveBeenCalled();
    });

    it('classifies an exact same-connection launch-model change as restart-required presentation', async () => {
        const value: { current: ReturnType<typeof useProviderBindingStatus> | null } = { current: null };
        function Harness() {
            value.current = useProviderBindingStatus({
                enabled: true,
                machineId: 'machine-a',
                serverId,
                selection: {
                    v: 1,
                    updatedAt: 2,
                    ref: {
                        agentTargetKey: 'agent:happier.agent.codex/codex',
                        providerConnectionId: ProviderConnectionIdSchema.parse('pc_launch'),
                        modelId: 'next',
                    },
                },
                launchBinding: {
                    v: 1,
                    connectionId: ProviderConnectionIdSchema.parse('pc_launch'),
                    contributionKey: null,
                    connectionRevision: 1,
                    model: { id: 'old', name: 'Old' },
                    protocol: 'openai-responses',
                    materialization: 'engineConfig',
                    compatibilityFingerprint: 'compatibility:v1:a',
                    bindingSecurityFingerprint: 'binding-security:v1:a',
                    displaySnapshot: {
                        providerName: 'Gateway',
                        connectionName: 'Launch',
                        connectionRole: 'named',
                        connectionDisplayNameMode: 'custom',
                    },
                },
            });
            return React.createElement('View');
        }

        await renderScreen(<Harness />);
        await act(async () => {});

        expect(value.current?.status).toEqual({ status: 'selection_changed' });
        expect(describeProviderBindingStatus).not.toHaveBeenCalled();
    });

    it('classifies an explicit provider-to-native reset as changed without sending an invalid launch tuple', async () => {
        const value: { current: ReturnType<typeof useProviderBindingStatus> | null } = { current: null };
        function Harness() {
            value.current = useProviderBindingStatus({
                enabled: true,
                machineId: 'machine-a',
                serverId,
                selection: null,
                selectionIntentPresent: true,
                launchBinding: {
                    v: 1, connectionId: ProviderConnectionIdSchema.parse('pc_launch'), contributionKey: null, connectionRevision: 1,
                    protocol: 'openai-responses', materialization: 'engineConfig',
                    compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
                    displaySnapshot: {
                        providerName: 'Gateway', connectionName: 'Launch', connectionRole: 'named', connectionDisplayNameMode: 'custom',
                    },
                },
            });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => {});
        expect(value.current?.status).toEqual({ status: 'selection_changed' });
        expect(describeProviderBindingStatus).not.toHaveBeenCalled();
    });

    it('projects daemon transport failures as typed state instead of erasing them', async () => {
        describeProviderBindingStatus.mockRejectedValueOnce(new Error('offline'));
        const value: { current: ReturnType<typeof useProviderBindingStatus> | null } = { current: null };
        function Harness() {
            value.current = useProviderBindingStatus({
                enabled: true,
                machineId: 'machine-a',
                serverId,
                selectionIntentPresent: true,
                selection: {
                    v: 1, updatedAt: 2,
                    ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_launch'), modelId: 'next' },
                },
                launchBinding: {
                    v: 1, connectionId: ProviderConnectionIdSchema.parse('pc_launch'), contributionKey: null, connectionRevision: 1,
                    protocol: 'openai-responses', materialization: 'engineConfig',
                    compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
                    displaySnapshot: {
                        providerName: 'Gateway', connectionName: 'Launch', connectionRole: 'named', connectionDisplayNameMode: 'custom',
                    },
                },
            });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => {});
        expect(value.current).toMatchObject({
            status: null,
            loading: false,
            error: createProviderErrorV1('machine_offline', {
                connectionId: 'pc_launch',
                machineId: 'machine-a',
            }),
        });
    });
});
