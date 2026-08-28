import { describe, expect, it, vi } from 'vitest';

import type { ExternalSessionFollowHostOperation } from './followHostOperation';
import {
    createExternalSessionHostOperationOwner,
    type ExternalSessionHostOperationOwner,
    type ExternalSessionHostOperationSet,
} from './hostOperationOwner';

const source = Object.freeze({ kind: 'codexHome', home: 'user' } as const);
const ref = Object.freeze({
    agentId: 'codex',
    sourceId: 'source-1',
    remoteSessionId: 'remote-1',
});

function createBindingInput(overrides: Partial<Readonly<{
    pluginId: string;
    agentId: string;
    generationId: string;
    sessionId: string;
    machineId: string;
    readAccountRevision: () => string | null;
    sessionSignal: AbortSignal;
    generationRetirementSignal: AbortSignal;
    isGenerationCurrent: () => boolean;
}>> = {}) {
    return {
        pluginId: 'acme.plugin',
        agentId: 'codex',
        generationId: 'generation-1',
        sessionId: 'session-1',
        machineId: 'machine-1',
        readAccountRevision: () => 'account-1',
        isGenerationCurrent: () => true,
        ...overrides,
    };
}

function followRequest(signal?: AbortSignal) {
    return {
        ref,
        source,
        options: {
            ...(signal ? { signal } : {}),
        },
        listener: vi.fn(),
    };
}

function providerSessionFollowRequest(
    signal?: AbortSignal,
    admissionDeadlineAtMs?: number,
) {
    return {
        agentId: 'codex',
        providerSessionId: 'remote-1',
        options: {
            ...(admissionDeadlineAtMs === undefined
                ? {}
                : { admissionDeadlineAtMs }),
            ...(signal ? { signal } : {}),
        },
        listener: vi.fn(),
    };
}

function unavailableFollowOperation(
    execute: ExternalSessionFollowHostOperation['execute'] =
        vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'test_unavailable',
        })),
): ExternalSessionFollowHostOperation {
    return Object.freeze({ execute });
}

async function installOperations(
    owner: ExternalSessionHostOperationOwner,
    operations: ExternalSessionHostOperationSet,
) {
    return await owner.install(operations);
}

describe('external-session daemon host-operation owner', () => {
    it('resolves and follows one provider session without exposing its exact target to the caller', async () => {
        const resolveTarget = vi.fn(async () => Object.freeze({
            status: 'resolved' as const,
            ref,
            source,
        }));
        const followExecute = vi.fn(async () => Object.freeze({
            status: 'following' as const,
            startingCursor: 'cursor-1',
            subscription: Object.freeze({
                dispose: vi.fn(async () => undefined),
            }),
        }));
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followTargetOperation: Object.freeze({ execute: resolveTarget }),
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput());

        const result = await binding.executeProviderSessionFollow(
            providerSessionFollowRequest(undefined, 25_000),
        );

        expect(result).toMatchObject({
            status: 'following',
            startingCursor: 'cursor-1',
        });
        expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.plugin',
            contributionId: 'codex',
            generationId: 'generation-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            accountRevision: 'account-1',
            remoteSessionId: 'remote-1',
            admissionDeadlineAtMs: 25_000,
            signal: expect.any(AbortSignal),
            isCurrent: expect.any(Function),
        }));
        expect(followExecute).toHaveBeenCalledWith(expect.objectContaining({
            ref,
            source,
            listener: expect.any(Function),
        }));

        await expect(binding.executeProviderSessionFollow({
            ...providerSessionFollowRequest(),
            agentId: 'claude',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_mismatch',
        });
        expect(resolveTarget).toHaveBeenCalledOnce();
        expect(followExecute).toHaveBeenCalledOnce();
    });

    it('distinguishes a never-installed owner from a retired generation', async () => {
        // The owner is constructed unconditionally at daemon startup; a generation is
        // installed into it only during machine-RPC registration. A binding taken in
        // between has no generation, which is NOT the same as having had one retired.
        const owner = createExternalSessionHostOperationOwner();
        const binding = owner.bind(createBindingInput());

        expect(owner.canFollowNow()).toBe(false);
        await expect(binding.executeFollow(followRequest())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_host_operations_uninstalled',
        });
        await expect(
            binding.executeProviderSessionFollow(providerSessionFollowRequest()),
        ).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_host_operations_uninstalled',
        });

        // Once installed, the same owner reports follow as runnable.
        const installation = await installOperations(owner, {
            followOperation: unavailableFollowOperation(),
        });
        expect(owner.canFollowNow()).toBe(true);

        // ...and a generation that WAS installed and then went away is genuinely retired,
        // so that code must not be replaced by the uninstalled one.
        await installation.dispose();
        expect(owner.canFollowNow()).toBe(false);
        await expect(binding.executeFollow(followRequest())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_host_operations_uninstalled',
        });
        await owner.retire();
    });

    it('fails closed before exact follow for unavailable or malformed provider-session targets', async () => {
        const resolveTarget = vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'plugin_external_follow_identity_ambiguous',
        }));
        const followExecute = vi.fn();
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followTargetOperation: Object.freeze({ execute: resolveTarget }),
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput());

        await expect(binding.executeProviderSessionFollow(
            providerSessionFollowRequest(),
        )).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_ambiguous',
        });
        await expect(binding.executeProviderSessionFollow({
            ...providerSessionFollowRequest(),
            providerSessionId: ' remote-1',
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_mismatch',
        });
        await expect(binding.executeProviderSessionFollow({
            ...providerSessionFollowRequest(),
            providerSessionId: 'x'.repeat(2_001),
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_mismatch',
        });
        expect(resolveTarget).toHaveBeenCalledOnce();
        expect(followExecute).not.toHaveBeenCalled();
    });

    it('rejects a resolved target whose ref exceeds the singular Agent bound or carries private fields', async () => {
        const overlongAgentId = 'a'.repeat(129);
        const resolveTarget = vi.fn(async () => Object.freeze({
            status: 'resolved' as const,
            ref: Object.freeze({
                agentId: overlongAgentId,
                sourceId: 'codexHome:user:::',
                remoteSessionId: 'remote-1',
                source: { kind: 'codexHome', home: 'private' },
            }),
            source,
        }));
        const followExecute = vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'invalid-ref-reached-follow',
        }));
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followTargetOperation: Object.freeze({ execute: resolveTarget as never }),
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput({ agentId: overlongAgentId }));

        await expect(binding.executeProviderSessionFollow({
            ...providerSessionFollowRequest(),
            agentId: overlongAgentId,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_unavailable',
        });
        expect(resolveTarget).toHaveBeenCalledOnce();
        expect(followExecute).not.toHaveBeenCalled();
    });

    it('does not start exact follow when account or generation currentness changes during target resolution', async () => {
        let releaseTarget!: (
            value: Readonly<{
                status: 'resolved';
                ref: typeof ref;
                source: typeof source;
            }>,
        ) => void;
        const targetPending = new Promise<Readonly<{
            status: 'resolved';
            ref: typeof ref;
            source: typeof source;
        }>>((resolve) => {
            releaseTarget = resolve;
        });
        const resolveTarget = vi.fn(async () => await targetPending);
        const followExecute = vi.fn();
        let accountRevision = 'account-1';
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followTargetOperation: Object.freeze({ execute: resolveTarget }),
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput({
            readAccountRevision: () => accountRevision,
        }));
        const result = binding.executeProviderSessionFollow(
            providerSessionFollowRequest(),
        );
        await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledOnce());
        accountRevision = 'account-2';
        releaseTarget(Object.freeze({ status: 'resolved', ref, source }));

        await expect(result).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(followExecute).not.toHaveBeenCalled();
    });

    it('binds authoritative daemon machine/account plus plugin, Agent, generation, and session identity', async () => {
        const followExecute = vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'test_unavailable',
        }));
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followOperation: unavailableFollowOperation(followExecute),
        });
        let accountRevision: string | null = 'account-1';
        const binding = owner.bind(createBindingInput());

        await binding.executeFollow(followRequest());

        expect(followExecute).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.plugin',
            contributionId: 'codex',
            generationId: 'generation-1',
            machineId: 'machine-1',
            isCurrent: expect.any(Function),
        }));

        const foreignRef = { ...ref, agentId: 'claude' };
        await expect(binding.executeFollow({
            ...followRequest(),
            ref: foreignRef,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_mismatch',
        });
        expect(followExecute).toHaveBeenCalledTimes(1);

        const accountScopedBinding = owner.bind(createBindingInput({
            readAccountRevision: () => accountRevision,
        }));
        accountRevision = 'account-2';
        await expect(
            accountScopedBinding.executeFollow(followRequest()),
        ).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(followExecute).toHaveBeenCalledTimes(1);
    });

    it('invalidates every old binding on replacement and a stale install dispose cannot retire the replacement', async () => {
        const firstFollow = vi.fn();
        const replacementFollow = vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'replacement',
        }));
        const owner = createExternalSessionHostOperationOwner();
        const firstInstallation = await installOperations(owner, {
            followOperation: unavailableFollowOperation(firstFollow),
        });
        const oldBinding = owner.bind(createBindingInput());

        await installOperations(owner, {
            followOperation: unavailableFollowOperation(replacementFollow),
        });
        await firstInstallation.dispose();

        await expect(oldBinding.executeFollow(followRequest())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(firstFollow).not.toHaveBeenCalled();
        expect(replacementFollow).not.toHaveBeenCalled();

        const replacementBinding = owner.bind(createBindingInput({
            generationId: 'generation-2',
            sessionId: 'session-2',
        }));
        await replacementBinding.executeFollow(followRequest());
        expect(replacementFollow).toHaveBeenCalledOnce();
    });

    it.each([
        ['caller', 'caller'],
        ['session', 'session'],
        ['generation', 'generation'],
        ['owner', 'owner'],
    ] as const)(
        'composes %s cancellation and disposes one active follow exactly once',
        async (_label, cancelledBy) => {
            const caller = new AbortController();
            const session = new AbortController();
            const generation = new AbortController();
            const dispose = vi.fn(async () => undefined);
            const followOperation = unavailableFollowOperation(vi.fn(async () => Object.freeze({
                status: 'following' as const,
                startingCursor: 'cursor-1',
                subscription: Object.freeze({ dispose }),
            })));
            const owner = createExternalSessionHostOperationOwner();
            await installOperations(owner, {
                followOperation,
            });
            const binding = owner.bind(createBindingInput({
                sessionSignal: session.signal,
                generationRetirementSignal: generation.signal,
                isGenerationCurrent: () => !generation.signal.aborted,
            }));
            const result = await binding.executeFollow(followRequest(caller.signal));
            expect(result.status).toBe('following');

            if (cancelledBy === 'caller') caller.abort();
            if (cancelledBy === 'session') session.abort();
            if (cancelledBy === 'generation') generation.abort();
            if (cancelledBy === 'owner') await owner.retire();

            await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
            if (result.status === 'following') {
                await result.subscription.dispose();
                await result.subscription.dispose();
            }
            await binding.retire();
            await owner.retire();
            expect(dispose).toHaveBeenCalledOnce();
        },
    );

    it('bounds replacement and owner retirement when a follow disposer never settles', async () => {
        vi.useFakeTimers();
        try {
            const firstDispose = vi.fn(
                async () => await new Promise<void>(() => undefined),
            );
            const owner = createExternalSessionHostOperationOwner();
            await installOperations(owner, {
                followOperation: unavailableFollowOperation(
                    vi.fn(async () => Object.freeze({
                        status: 'following' as const,
                        startingCursor: 'cursor-1',
                        subscription: Object.freeze({
                            dispose: firstDispose,
                        }),
                    })),
                ),
            });
            const firstBinding = owner.bind(createBindingInput());
            await expect(
                firstBinding.executeFollow(followRequest()),
            ).resolves.toMatchObject({ status: 'following' });

            let replacementSettled = false;
            const replacement = installOperations(owner, {
                followOperation: null,
            }).then((installation) => {
                replacementSettled = true;
                return installation;
            });
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(5_000);
            await Promise.resolve();

            expect(replacementSettled).toBe(true);
            await replacement;
            expect(firstDispose).toHaveBeenCalledOnce();

            const secondDispose = vi.fn(
                async () => await new Promise<void>(() => undefined),
            );
            await installOperations(owner, {
                followOperation: unavailableFollowOperation(
                    vi.fn(async () => Object.freeze({
                        status: 'following' as const,
                        startingCursor: 'cursor-2',
                        subscription: Object.freeze({
                            dispose: secondDispose,
                        }),
                    })),
                ),
            });
            const secondBinding = owner.bind(createBindingInput({
                generationId: 'generation-2',
                sessionId: 'session-2',
            }));
            await expect(
                secondBinding.executeFollow(followRequest()),
            ).resolves.toMatchObject({ status: 'following' });

            let retirementSettled = false;
            const retirement = owner.retire().then(() => {
                retirementSettled = true;
            });
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(5_000);
            await Promise.resolve();

            expect(retirementSettled).toBe(true);
            await retirement;
            expect(secondDispose).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('never reports unsettled explicit follow cleanup as disposal and keeps the exact handle retryable', async () => {
        vi.useFakeTimers();
        try {
            let failFirstCleanup!: (error: unknown) => void;
            let cleanupAttempts = 0;
            const dispose = vi.fn(() => {
                cleanupAttempts += 1;
                if (cleanupAttempts === 1) {
                    return new Promise<void>((_, reject) => {
                        failFirstCleanup = reject;
                    });
                }
                return Promise.resolve();
            });
            const owner = createExternalSessionHostOperationOwner();
            await installOperations(owner, {
                followOperation: unavailableFollowOperation(
                    vi.fn(async () => Object.freeze({
                        status: 'following' as const,
                        startingCursor: 'cursor-1',
                        subscription: Object.freeze({ dispose }),
                    })),
                ),
            });
            const binding = owner.bind(createBindingInput());
            const followed = await binding.executeFollow(followRequest());
            if (followed.status !== 'following') {
                throw new Error('expected follow');
            }

            // Cleanup that has not settled by the ceiling is unresolved cleanup,
            // not finished cleanup. Resolving here is what let the retained-Agent
            // follow close delete a still-live provider subscription and report
            // success for it.
            const first = Promise.resolve(followed.subscription.dispose());
            const firstSettled = first.catch(() => undefined);
            await vi.advanceTimersByTimeAsync(4_999);
            let settled = false;
            void firstSettled.finally(() => { settled = true; });
            await Promise.resolve();
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(first).rejects.toThrow(
                'plugin_external_follow_cleanup_deadline_exceeded',
            );

            // A retry joins the invocation the provider is still running instead
            // of disposing the same handle a second time.
            const second = Promise.resolve(followed.subscription.dispose());
            const secondSettled = second.catch(() => undefined);
            await Promise.resolve();
            expect(dispose).toHaveBeenCalledOnce();

            // The failure that arrives after the ceiling is surfaced, not
            // discarded beside the state machine.
            failFirstCleanup(new Error('provider cleanup rejected'));
            await expect(second).rejects.toThrow('provider cleanup rejected');
            await secondSettled;

            // Custody was retained through both failures, so the exact handle is
            // disposed for real on the next attempt and only then leaves the
            // owner's active sets.
            await expect(followed.subscription.dispose())
                .resolves.toBeUndefined();
            expect(dispose).toHaveBeenCalledTimes(2);
            await owner.retire();
            expect(dispose).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('disposes a listener-failed provisional follow without retiring sibling follows', async () => {
        const firstDispose = vi.fn(async () => undefined);
        const secondDispose = vi.fn(async () => undefined);
        const operationListeners: Array<
            Parameters<ExternalSessionFollowHostOperation['execute']>[0]['listener']
        > = [];
        const followExecute = vi.fn(async (request) => {
            operationListeners.push(request.listener);
            return Object.freeze({
                status: 'following' as const,
                startingCursor: 'cursor-1',
                subscription: Object.freeze({
                    dispose:
                        operationListeners.length === 1
                            ? firstDispose
                            : secondDispose,
                }),
            });
        });
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput());
        const failingListener = vi.fn(async () => {
            throw new Error('bridge congested');
        });
        const healthyListener = vi.fn(async () => undefined);
        const first = await binding.executeFollow({
            ...followRequest(),
            listener: failingListener,
        });
        const second = await binding.executeFollow({
            ...followRequest(),
            listener: healthyListener,
        });
        expect(first.status).toBe('following');
        expect(second.status).toBe('following');

        await expect(operationListeners[0]!({
            kind: 'resyncRequired',
            reason: 'bufferOverflow',
            cursor: 'cursor-1',
        })).rejects.toThrow('bridge congested');
        await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledOnce());
        expect(secondDispose).not.toHaveBeenCalled();
        await expect(operationListeners[1]!({
            kind: 'resyncRequired',
            reason: 'bufferOverflow',
            cursor: 'cursor-1',
        })).resolves.toBeUndefined();
        expect(healthyListener).toHaveBeenCalledOnce();

        if (second.status === 'following') {
            await second.subscription.dispose();
        }
        expect(secondDispose).toHaveBeenCalledOnce();
    });

    it('bounds a never-settling listener, retires only that follow, and leaves a sibling live', async () => {
        vi.useFakeTimers();
        try {
            let releaseHeldListener!: () => void;
            const heldListener = new Promise<void>((resolve) => {
                releaseHeldListener = resolve;
            });
            const firstDispose = vi.fn(async () => undefined);
            const secondDispose = vi.fn(async () => undefined);
            const operationListeners: Array<
                Parameters<ExternalSessionFollowHostOperation['execute']>[0]['listener']
            > = [];
            const followExecute = vi.fn(async (request) => {
                operationListeners.push(request.listener);
                return Object.freeze({
                    status: 'following' as const,
                    startingCursor: 'cursor-1',
                    subscription: Object.freeze({
                        dispose: operationListeners.length === 1
                            ? firstDispose
                            : secondDispose,
                    }),
                });
            });
            const owner = createExternalSessionHostOperationOwner();
            await installOperations(owner, {
                followOperation: unavailableFollowOperation(followExecute),
            });
            const binding = owner.bind(createBindingInput());
            const first = await binding.executeFollow({
                ...followRequest(),
                listener: vi.fn(async () => await heldListener),
            });
            const healthyListener = vi.fn(async () => undefined);
            const second = await binding.executeFollow({
                ...followRequest(),
                listener: healthyListener,
            });

            const heldDelivery = operationListeners[0]!({
                kind: 'resyncRequired', reason: 'bufferOverflow', cursor: 'cursor-1',
            });
            const heldDeliveryAssertion = expect(heldDelivery).rejects.toThrow(
                'plugin_external_follow_listener_deadline_exceeded',
            );
            await vi.advanceTimersByTimeAsync(5_000);
            await heldDeliveryAssertion;
            expect(firstDispose).toHaveBeenCalledOnce();
            expect(secondDispose).not.toHaveBeenCalled();

            await expect(operationListeners[1]!({
                kind: 'resyncRequired', reason: 'bufferOverflow', cursor: 'cursor-1',
            })).resolves.toBeUndefined();
            expect(healthyListener).toHaveBeenCalledOnce();

            releaseHeldListener();
            await Promise.resolve();
            expect(firstDispose).toHaveBeenCalledOnce();
            expect(healthyListener).toHaveBeenCalledOnce();

            if (first.status === 'following') {
                await expect(first.subscription.dispose()).resolves.toBeUndefined();
            }
            if (second.status === 'following') await second.subscription.dispose();
            expect(secondDispose).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps a late follow acquisition inside the state machine when retirement raced it', async () => {
        // Retirement can settle while acquisition is still in flight: the
        // disposal that ran then had no handle to release. The subscription the
        // operation hands back afterwards is still this follow's to clean up,
        // so a pre-ceiling cleanup rejection must leave the exact handle
        // discoverable through the owner rather than dropping it beside the
        // state machine.
        let disposeAttempts = 0;
        const dispose = vi.fn(async () => {
            disposeAttempts += 1;
            if (disposeAttempts === 1) {
                throw new Error('plugin disposer rejected');
            }
        });
        const generationRetirement = new AbortController();
        let generationCurrent = true;
        let releaseAcquisition!: () => void;
        const acquisitionGate = new Promise<void>((resolve) => {
            releaseAcquisition = resolve;
        });
        const followExecute: ExternalSessionFollowHostOperation['execute'] =
            vi.fn(async () => {
                generationCurrent = false;
                generationRetirement.abort();
                await acquisitionGate;
                return Object.freeze({
                    status: 'following' as const,
                    startingCursor: 'cursor-1',
                    subscription: Object.freeze({ dispose }),
                });
            });
        const owner = createExternalSessionHostOperationOwner();
        const installation = await installOperations(owner, {
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput({
            generationRetirementSignal: generationRetirement.signal,
            isGenerationCurrent: () => generationCurrent,
        }));

        const followed = binding.executeFollow(followRequest());
        releaseAcquisition();
        await expect(followed).rejects.toThrow('plugin disposer rejected');
        expect(dispose).toHaveBeenCalledOnce();

        // The rejected cleanup is retried through the owner, on the exact
        // handle acquisition handed back after retirement had already settled.
        await installation.dispose();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('admits more than 64 active follows and cleans or cancels each one independently', async () => {
        const disposals: Array<ReturnType<typeof vi.fn>> = [];
        const followExecute: ExternalSessionFollowHostOperation['execute'] =
            vi.fn(async () => {
                const dispose = vi.fn(async () => undefined);
                disposals.push(dispose);
                return Object.freeze({
                    status: 'following' as const,
                    startingCursor: 'cursor-1',
                    subscription: Object.freeze({ dispose }),
                });
            });
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput());
        const cancellation = new AbortController();
        const follows = [];
        for (let index = 0; index < 65; index += 1) {
            follows.push(await binding.executeFollow(
                followRequest(index === 64 ? cancellation.signal : undefined),
            ));
        }
        expect(follows.every((follow) => follow.status === 'following')).toBe(true);
        expect(followExecute).toHaveBeenCalledTimes(65);

        cancellation.abort();
        await vi.waitFor(() => expect(disposals[64]).toHaveBeenCalledOnce());
        await Promise.all(follows.slice(0, 64).map(async (follow) => {
            if (follow.status === 'following') await follow.subscription.dispose();
        }));
        expect(disposals.every((dispose) => dispose.mock.calls.length === 1))
            .toBe(true);
    });

    it('rejects oversized events without retiring sibling follows', async () => {
        const disposals: Array<ReturnType<typeof vi.fn>> = [];
        const operationListeners: Array<
            Parameters<ExternalSessionFollowHostOperation['execute']>[0]['listener']
        > = [];
        const followExecute: ExternalSessionFollowHostOperation['execute'] =
            vi.fn(async (request) => {
                operationListeners.push(request.listener);
                const dispose = vi.fn(async () => undefined);
                disposals.push(dispose);
                return Object.freeze({
                    status: 'following' as const,
                    startingCursor: 'cursor-1',
                    subscription: Object.freeze({ dispose }),
                });
            });
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput());
        const follows = await Promise.all([
            binding.executeFollow(followRequest()),
            binding.executeFollow(followRequest()),
        ]);
        expect(followExecute).toHaveBeenCalledTimes(2);

        await expect(operationListeners[0]!({
            kind: 'terminated',
            reason: 'providerFailure',
            cursor: 'cursor-1',
            code: 'x'.repeat(1024 * 1024),
        })).rejects.toMatchObject({
            code: 'plugin_external_follow_event_too_large',
        });
        await vi.waitFor(() => expect(disposals[0]).toHaveBeenCalledOnce());
        expect(disposals[1]).not.toHaveBeenCalled();

        await Promise.all(
            follows.map(async (follow) => {
                if (follow.status === 'following') {
                    await follow.subscription.dispose();
                }
            }),
        );
        expect(disposals.every((dispose) => dispose.mock.calls.length === 1))
            .toBe(true);
    });

    it('admits a deeply nested valid follow event instead of reclassifying it as invalid', async () => {
        // The canonical transcript contract carries no generic depth quota, so
        // the follow-event byte bound must be measured iteratively.
        let output: unknown = 'leaf';
        for (let depth = 0; depth < 7_000; depth += 1) output = { nested: output };
        const operationListeners: Array<
            Parameters<ExternalSessionFollowHostOperation['execute']>[0]['listener']
        > = [];
        const followExecute: ExternalSessionFollowHostOperation['execute'] =
            vi.fn(async (request) => {
                operationListeners.push(request.listener);
                return Object.freeze({
                    status: 'following' as const,
                    startingCursor: 'cursor-1',
                    subscription: Object.freeze({ dispose: vi.fn(async () => undefined) }),
                });
            });
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput());
        const follow = await binding.executeFollow(followRequest());
        expect(follow.status).toBe('following');

        await expect(operationListeners[0]!({
            kind: 'data',
            items: [Object.freeze({
                id: 'deep',
                kind: 'event' as const,
                data: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'tool-call-result', callId: 'call-1', output } },
                },
            })],
            fromCursor: null,
            nextCursor: 'cursor-2',
        } as Parameters<typeof operationListeners[0]>[0])).resolves.toBeUndefined();

        if (follow.status === 'following') await follow.subscription.dispose();
    });

    it('owns abort-triggered retirement failure and never publishes a replacement without a cleanup handle', async () => {
        // `followHostOperation` proves a follow subscription disposer may reject once
        // and succeed on retry. When that happens during generation replacement the
        // owner must not (a) leak the abort callback's rejection to the process, where
        // the daemon converts it into `requestShutdown('exception')`, or (b) leave the
        // replacement generation callable after `install` rejected without returning a
        // cleanup handle for it.
        const cleanupFailure = new Error('follow cleanup failed');
        const dispose = vi.fn<() => Promise<void>>()
            .mockRejectedValueOnce(cleanupFailure)
            .mockResolvedValue(undefined);
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followOperation: unavailableFollowOperation(vi.fn(async () => Object.freeze({
                status: 'following' as const,
                startingCursor: 'cursor-1',
                subscription: Object.freeze({ dispose }),
            }))),
        });
        const binding = owner.bind(createBindingInput());
        await expect(binding.executeFollow(followRequest()))
            .resolves.toMatchObject({ status: 'following' });

        const replacementFollow = vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'replacement',
        }));
        const unhandled: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            await expect(installOperations(owner, {
                followOperation: unavailableFollowOperation(replacementFollow),
            })).rejects.toBe(cleanupFailure);
            // Let Node run its unhandled-rejection detection for this turn.
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }
        expect(dispose).toHaveBeenCalledTimes(1);
        // The failed installation returned no handle, so nothing may be callable.
        expect(owner.canFollowNow()).toBe(false);
        await expect(binding.executeFollow(followRequest())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(replacementFollow).not.toHaveBeenCalled();

        // Installing again retries the exact same cleanup and then succeeds atomically.
        const installation = await installOperations(owner, {
            followOperation: unavailableFollowOperation(replacementFollow),
        });
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(owner.canFollowNow()).toBe(true);
        const replacementBinding = owner.bind(createBindingInput({
            generationId: 'generation-2',
            sessionId: 'session-2',
        }));
        await expect(replacementBinding.executeFollow(followRequest()))
            .resolves.toEqual({ status: 'unavailable', code: 'replacement' });
        await installation.dispose();
        await owner.retire();
    });

    it('admits no new work after daemon-owner retirement', async () => {
        const followExecute = vi.fn();
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            followOperation: unavailableFollowOperation(followExecute),
        });
        await owner.retire();
        const binding = owner.bind(createBindingInput());

        await expect(binding.executeFollow(followRequest())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(followExecute).not.toHaveBeenCalled();
        await expect(owner.install({
            followOperation: unavailableFollowOperation(),
        })).rejects.toThrow('External Session host-operation owner is retired');
    });
});
