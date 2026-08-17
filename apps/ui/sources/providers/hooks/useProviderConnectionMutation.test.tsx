import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { DaemonProviderConnectionMutationRequestV1Schema } from '@happier-dev/protocol/rpc';
import type { z } from 'zod';

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

type ProviderConnectionMutationRequestInput = z.input<typeof DaemonProviderConnectionMutationRequestV1Schema>;
type PendingPresentation = Readonly<{
    isPending: (key: string) => boolean;
}>;

function isKeyPending(result: PendingPresentation, key: string): boolean {
    return result.isPending(key);
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
        });
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
        expect(hook.getCurrent()).not.toHaveProperty('errorCode');
        expect(events).toEqual(['commit', 'refresh']);
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('coalesces an identical pending mutation before it can dispatch twice', async () => {
        const deferred = createDeferred<Readonly<{
            status: 'success';
            action: 'delete';
            deletedConnectionId: string;
        }>>();
        machineRpcWithServerScope.mockReturnValueOnce(deferred.promise);
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(() => useProviderConnectionMutation({
            serverId: 'server-a',
            refresh,
        }));
        const request = {
            action: 'delete' as const,
            machineId: 'machine-a',
            connectionId: 'pc_a',
        };
        const duplicateRequest = {
            action: 'delete' as const,
            machineId: 'machine-a',
            connectionId: 'pc_a',
        };

        let first!: Promise<unknown>;
        let duplicate!: Promise<unknown>;
        await act(async () => {
            first = hook.getCurrent().run(request, 'delete');
            duplicate = hook.getCurrent().run(duplicateRequest, 'delete');
            await Promise.resolve();
        });

        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();

        await act(async () => {
            deferred.resolve({ status: 'success', action: 'delete', deletedConnectionId: 'pc_a' });
            await Promise.all([first, duplicate]);
        });

        expect(refresh).toHaveBeenCalledOnce();
    });

    it('keeps a captured mutation callback stable and invokes it against the current exact scope', async () => {
        const deferred = createDeferred<Readonly<{
            status: 'success';
            action: 'delete';
            deletedConnectionId: string;
        }>>();
        machineRpcWithServerScope.mockReturnValueOnce(deferred.promise);
        const refreshA = vi.fn(async () => undefined);
        const refreshB = vi.fn(async () => undefined);
        const hook = await renderHook(
            ({ serverId, refresh }: Readonly<{ serverId: string; refresh: () => Promise<void> }>) =>
                useProviderConnectionMutation({ serverId, refresh }),
            { initialProps: { serverId: 'server-a', refresh: refreshA } },
        );
        const capturedUnderA = hook.getCurrent().run;

        await hook.rerender({ serverId: 'server-b', refresh: refreshB });
        const currentRun = hook.getCurrent().run;

        const request = {
            action: 'delete' as const,
            machineId: 'machine-a',
            connectionId: 'pc_a',
        };
        let fromCapturedCallback!: Promise<unknown>;
        let fromCurrentCallback!: Promise<unknown>;
        await act(async () => {
            fromCapturedCallback = capturedUnderA(request, 'delete');
            fromCurrentCallback = hook.getCurrent().run({ ...request }, 'delete');
            await Promise.resolve();
        });

        await act(async () => {
            deferred.resolve({ status: 'success', action: 'delete', deletedConnectionId: 'pc_a' });
            await Promise.all([fromCapturedCallback, fromCurrentCallback]);
        });

        expect(fromCurrentCallback).toBe(fromCapturedCallback);
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(machineRpcWithServerScope).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'server-b' }));
        expect(currentRun).toBe(capturedUnderA);
        expect(refreshA).not.toHaveBeenCalled();
        expect(refreshB).toHaveBeenCalledOnce();
    });

    it('coalesces canonically equal requests but not material differences', async () => {
        const equivalentDeferred = createDeferred<Readonly<{
            status: 'error';
            error: ReturnType<typeof createProviderErrorV1>;
        }>>();
        const differentDeferred = createDeferred<Readonly<{
            status: 'error';
            error: ReturnType<typeof createProviderErrorV1>;
        }>>();
        const preNormalizationDuplicate = createDeferred<Readonly<{
            status: 'error';
            error: ReturnType<typeof createProviderErrorV1>;
        }>>();
        machineRpcWithServerScope
            .mockReturnValueOnce(equivalentDeferred.promise)
            .mockReturnValueOnce(differentDeferred.promise)
            .mockReturnValueOnce(preNormalizationDuplicate.promise);
        const refresh = vi.fn(async () => undefined);
        const hook = await renderHook(() => useProviderConnectionMutation({
            serverId: 'server-a',
            refresh,
        }));
        const firstRequest = {
            action: 'createCustom',
            machineId: 'machine-a',
            connectionId: 'pc_custom',
            template: {
                v: 1,
                name: ' Custom ',
                endpointTemplates: [{
                    id: 'anthropic',
                    protocol: 'anthropic',
                    baseUrl: 'https://gateway.example/anthropic',
                    capabilities: {
                        streaming: 'unknown',
                        toolRoundTrips: 'unknown',
                        statefulResponses: 'unknown',
                        reasoningControls: 'unknown',
                    },
                }],
                catalog: { source: 'manual', manualModelPolicy: 'allowed' },
            },
            savedSecretId: null,
            enable: false,
        } satisfies ProviderConnectionMutationRequestInput;
        const equivalentRequest = {
            enable: false,
            savedSecretId: null,
            template: {
                catalog: { manualModelPolicy: 'allowed', source: 'manual' },
                endpointTemplates: [{
                    capabilities: {
                        reasoningControls: 'unknown',
                        statefulResponses: 'unknown',
                        toolRoundTrips: 'unknown',
                        streaming: 'unknown',
                    },
                    baseUrl: 'https://gateway.example/anthropic',
                    protocol: 'anthropic',
                    id: 'anthropic',
                }],
                name: 'Custom',
                v: 1,
            },
            connectionId: 'pc_custom',
            machineId: 'machine-a',
            action: 'createCustom',
            manualModels: [],
        } satisfies ProviderConnectionMutationRequestInput;
        const materiallyDifferentRequest = {
            ...equivalentRequest,
            enable: true,
        } satisfies ProviderConnectionMutationRequestInput;

        let first!: Promise<unknown>;
        let equivalent!: Promise<unknown>;
        let materiallyDifferent!: Promise<unknown>;
        await act(async () => {
            first = hook.getCurrent().run(firstRequest, 'save');
            equivalent = hook.getCurrent().run(equivalentRequest, 'save');
            materiallyDifferent = hook.getCurrent().run(materiallyDifferentRequest, 'save');
            await Promise.resolve();
        });

        const error = createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: 'pc_custom',
            machineId: 'machine-a',
        });
        await act(async () => {
            equivalentDeferred.resolve({ status: 'error', error });
            differentDeferred.resolve({ status: 'error', error });
            preNormalizationDuplicate.resolve({ status: 'error', error });
            await Promise.all([first, equivalent, materiallyDifferent]);
        });

        expect(equivalent).toBe(first);
        expect(materiallyDifferent).not.toBe(first);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
        expect(machineRpcWithServerScope.mock.calls[0]?.[0]).toMatchObject({
            payload: {
                template: { name: 'Custom' },
                manualModels: [],
            },
        });
        expect(refresh).not.toHaveBeenCalled();
    });

    it('keeps every current-scope UI key pending until its own requests settle', async () => {
        const priorScope = createDeferred<Readonly<{
            status: 'success';
            action: 'delete';
            deletedConnectionId: string;
        }>>();
        const currentSharedFirst = createDeferred<Readonly<{
            status: 'success';
            action: 'delete';
            deletedConnectionId: string;
        }>>();
        const currentSharedSecond = createDeferred<Readonly<{
            status: 'success';
            action: 'delete';
            deletedConnectionId: string;
        }>>();
        const currentOther = createDeferred<Readonly<{
            status: 'success';
            action: 'delete';
            deletedConnectionId: string;
        }>>();
        machineRpcWithServerScope
            .mockReturnValueOnce(priorScope.promise)
            .mockReturnValueOnce(currentSharedFirst.promise)
            .mockReturnValueOnce(currentSharedSecond.promise)
            .mockReturnValueOnce(currentOther.promise);
        const refreshA = vi.fn(async () => undefined);
        const refreshB = vi.fn(async () => undefined);
        const hook = await renderHook(
            ({ serverId, refresh }: Readonly<{ serverId: string; refresh: () => Promise<void> }>) =>
                useProviderConnectionMutation({ serverId, refresh }),
            { initialProps: { serverId: 'server-a', refresh: refreshA } },
        );
        let fromPriorScope!: Promise<unknown>;
        await act(async () => {
            fromPriorScope = hook.getCurrent().run({
                action: 'delete', machineId: 'machine-a', connectionId: 'pc_prior',
            }, 'shared');
            await Promise.resolve();
        });

        await hook.rerender({ serverId: 'server-b', refresh: refreshB });
        let firstCurrentShared!: Promise<unknown>;
        let secondCurrentShared!: Promise<unknown>;
        let currentOtherRequest!: Promise<unknown>;
        await act(async () => {
            firstCurrentShared = hook.getCurrent().run({
                action: 'delete', machineId: 'machine-a', connectionId: 'pc_first',
            }, 'shared');
            secondCurrentShared = hook.getCurrent().run({
                action: 'delete', machineId: 'machine-a', connectionId: 'pc_second',
            }, 'shared');
            currentOtherRequest = hook.getCurrent().run({
                action: 'delete', machineId: 'machine-a', connectionId: 'pc_other',
            }, 'other');
            await Promise.resolve();
        });

        const observedPending = [[
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]];

        await act(async () => {
            priorScope.resolve({ status: 'success', action: 'delete', deletedConnectionId: 'pc_prior' });
            await fromPriorScope;
        });
        observedPending.push([
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]);

        await act(async () => {
            currentSharedFirst.resolve({ status: 'success', action: 'delete', deletedConnectionId: 'pc_first' });
            await firstCurrentShared;
        });
        observedPending.push([
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]);

        await act(async () => {
            currentOther.resolve({ status: 'success', action: 'delete', deletedConnectionId: 'pc_other' });
            await currentOtherRequest;
        });
        observedPending.push([
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]);

        await act(async () => {
            currentSharedSecond.resolve({ status: 'success', action: 'delete', deletedConnectionId: 'pc_second' });
            await secondCurrentShared;
        });
        observedPending.push([
            isKeyPending(hook.getCurrent(), 'shared'),
            isKeyPending(hook.getCurrent(), 'other'),
        ]);

        expect(observedPending).toEqual([
            [true, true],
            [true, true],
            [true, true],
            [true, false],
            [false, false],
        ]);
        expect(hook.getCurrent()).not.toHaveProperty('pendingKey');
        expect(hook.getCurrent()).toHaveProperty('isPending');
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
        expect(hook.getCurrent()).toMatchObject({ error: null });
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
    });
});
