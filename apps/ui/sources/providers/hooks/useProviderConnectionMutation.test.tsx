import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import {
    createProviderConnectionViewFixture,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));

import { useProviderConnectionMutation } from './useProviderConnectionMutation';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

describe('useProviderConnectionMutation', () => {
    afterEach(standardCleanup);
    beforeEach(() => machineRpcWithServerScope.mockReset());

    it('reconciles after a commit-then-reject transport failure without exposing a replay', async () => {
        const events: string[] = [];
        machineRpcWithServerScope.mockImplementationOnce(async () => {
            events.push('commit');
            throw new Error('acknowledgement lost after dispatch');
        });
        const refresh = vi.fn(async () => { events.push('refresh'); });
        const hook = await renderHook(() => useProviderConnectionMutation({
            serverId: 'server-a',
            refresh,
        }));

        await act(async () => {
            await hook.getCurrent().run({
                action: 'delete',
                machineId: 'machine-a',
                connectionId: 'pc_a',
            });
        });

        expect(hook.getCurrent()).toMatchObject({
            error: createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }),
            pendingKey: null,
        });
        expect(hook.getCurrent()).not.toHaveProperty('errorCode');
        expect(events).toEqual(['commit', 'refresh']);
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('reconciles a committed create with a malformed response before offering current-state review', async () => {
        const events: string[] = [];
        machineRpcWithServerScope.mockImplementationOnce(async () => {
            events.push('commit');
            return { status: 'success', action: 'createContribution' };
        });
        const refresh = vi.fn(async () => { events.push('refresh'); });
        const hook = await renderHook(() => useProviderConnectionMutation({
            serverId: 'server-a',
            refresh,
        }));

        await act(async () => {
            await hook.getCurrent().run({
                action: 'createContribution',
                machineId: 'machine-a',
                connectionId: 'pc_created',
                contributionKey: 'acme.gateway/main',
                displayName: null,
                savedSecretId: null,
                enable: false,
                authoringReview: {
                    candidateId: null,
                    fingerprint: 'authoring-review:v1:reviewed',
                    revision: 0,
                },
            });
        });

        expect(events).toEqual(['commit', 'refresh']);
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
            connectionId: 'pc_created',
            machineId: 'machine-a',
        }));
    });

    it('preserves acknowledged create, update, and delete results when only their follow-up read fails', async () => {
        const refresh = vi.fn(async () => { throw new Error('catalog refresh unavailable'); });
        const hook = await renderHook(() => useProviderConnectionMutation({
            serverId: 'server-a',
            refresh,
        }));
        const connection = createProviderConnectionViewFixture({ connectionId: 'pc_a' });
        const cases = [
            {
                request: {
                    action: 'createContribution' as const,
                    machineId: 'machine-a', connectionId: 'pc_a',
                    contributionKey: 'acme.gateway/main', displayName: null,
                    savedSecretId: null, enable: false,
                    authoringReview: {
                        candidateId: null,
                        fingerprint: 'authoring-review:v1:reviewed',
                        revision: 0,
                    },
                },
                response: { status: 'success' as const, action: 'createContribution' as const, connection },
            },
            {
                request: {
                    action: 'update' as const,
                    machineId: 'machine-a', connectionId: 'pc_a', expectedRevision: 1,
                    displayName: 'Updated', displayNameMode: 'custom' as const,
                },
                response: { status: 'success' as const, action: 'update' as const, connection },
            },
            {
                request: { action: 'delete' as const, machineId: 'machine-a', connectionId: 'pc_a' },
                response: { status: 'success' as const, action: 'delete' as const, deletedConnectionId: 'pc_a' },
            },
        ];

        for (const testCase of cases) {
            machineRpcWithServerScope.mockResolvedValueOnce(testCase.response);
            let result: unknown;
            await act(async () => {
                result = await hook.getCurrent().run(testCase.request);
            });
            expect(result).toEqual(testCase.response);
            expect(hook.getCurrent().error).toEqual(createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: 'pc_a',
                machineId: 'machine-a',
            }));
            expect(hook.getCurrent().retry).toBe(refresh);
        }

        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(3);
        expect(refresh).toHaveBeenCalledTimes(3);
    });

    it('does not refresh or publish a mutation result after the server/query scope changes', async () => {
        const deferred = createDeferred<Readonly<{ status: 'success'; action: 'delete'; deletedConnectionId: string }>>();
        machineRpcWithServerScope.mockReturnValueOnce(deferred.promise);
        const refreshA = vi.fn(async () => undefined);
        const refreshB = vi.fn(async () => undefined);
        const hook = await renderHook(
            ({ serverId, refresh }: Readonly<{ serverId: string; refresh: () => Promise<void> }>) =>
                useProviderConnectionMutation({ serverId, refresh }),
            { initialProps: { serverId: 'server-a', refresh: refreshA } },
        );

        let resultPromise!: Promise<unknown>;
        await act(async () => {
            resultPromise = hook.getCurrent().run({
                action: 'delete',
                machineId: 'machine-a',
                connectionId: 'pc_a',
            });
        });
        await hook.rerender({ serverId: 'server-b', refresh: refreshB });
        await act(async () => {
            deferred.resolve({ status: 'success', action: 'delete', deletedConnectionId: 'pc_a' });
            await resultPromise;
        });

        expect(refreshA).not.toHaveBeenCalled();
        expect(refreshB).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toMatchObject({ pendingKey: null, error: null });
    });
});
