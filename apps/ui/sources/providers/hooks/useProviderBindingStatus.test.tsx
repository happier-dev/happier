import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';

const describeProviderBindingStatus = vi.hoisted(() => vi.fn());
vi.mock('@/providers/rpc/client', () => ({
    describeProviderBindingStatus,
    providerErrorFromRpcFailure: (_caught: unknown, context: Readonly<Record<string, unknown>>) =>
        createProviderErrorV1('provider_endpoint_unavailable', context),
}));

import { useProviderBindingStatus } from './useProviderBindingStatus';

describe('useProviderBindingStatus', () => {
    beforeEach(() => { describeProviderBindingStatus.mockReset(); });
    it('clears a successful binding status immediately when its machine scope changes', async () => {
        let resolveB!: (value: unknown) => void;
        describeProviderBindingStatus
            .mockResolvedValueOnce({ status: 'current' })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const value: { current: ReturnType<typeof useProviderBindingStatus> | null } = { current: null };
        const selection = {
            v: 1 as const, updatedAt: 2,
            ref: { agentTargetKey: 'backend:codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_launch'), modelId: 'next' },
        };
        const launchBinding = {
            v: 1 as const, connectionId: ProviderConnectionIdSchema.parse('pc_launch'), contributionKey: null, connectionRevision: 1,
            protocol: 'openai-responses' as const, materialization: 'engineConfig' as const,
            compatibilityFingerprint: 'compatibility:v1:a', bindingSecurityFingerprint: 'binding-security:v1:a',
            displaySnapshot: { providerName: 'Gateway', connectionName: 'Launch', connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const },
        };
        function Harness(props: { machineId: string }) {
            value.current = useProviderBindingStatus({
                enabled: true, machineId: props.machineId, serverId: 'server-a', selection, launchBinding,
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

    it('does not call the daemon without one exact provider-bound launch tuple', async () => {
        function Harness() {
            useProviderBindingStatus({ enabled: true, machineId: 'machine-a', serverId: 'server-a', selection: null, launchBinding: null });
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
                enabled: true, machineId: 'machine-a', serverId: 'server-a',
                selection: {
                    v: 1, updatedAt: 2,
                    ref: { agentTargetKey: 'backend:codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_next'), modelId: 'next' },
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
                serverId: 'server-a',
                selection: {
                    v: 1,
                    updatedAt: 2,
                    ref: {
                        agentTargetKey: 'backend:codex',
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
                serverId: 'server-a',
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
                serverId: 'server-a',
                selectionIntentPresent: true,
                selection: {
                    v: 1, updatedAt: 2,
                    ref: { agentTargetKey: 'backend:codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_launch'), modelId: 'next' },
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
            error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_launch',
                machineId: 'machine-a',
            }),
        });
    });
});
