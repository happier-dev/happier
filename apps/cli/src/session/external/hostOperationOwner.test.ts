import { describe, expect, it, vi } from 'vitest';

import { PluginError } from '@happier-dev/plugin-sdk';

import {
    createExternalSessionTakeoverHostOperation,
    type ExternalSessionTakeoverHostOperation,
} from './takeoverHostOperation';
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

function takeoverRequest(signal?: AbortSignal) {
    return {
        ref,
        source,
        ...(signal ? { signal } : {}),
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

function providerSessionFollowRequest(signal?: AbortSignal) {
    return {
        agentId: 'codex',
        providerSessionId: 'remote-1',
        options: {
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

function unavailableTakeoverOperation(
    execute: ExternalSessionTakeoverHostOperation['execute'] =
        vi.fn(async () => Object.freeze({
            sessionId: 'linked-1',
            status: 'takenOver' as const,
        })),
): ExternalSessionTakeoverHostOperation {
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
            takeoverOperation: null,
            followTargetOperation: Object.freeze({ execute: resolveTarget }),
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput());

        const result = await binding.executeProviderSessionFollow(
            providerSessionFollowRequest(),
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

    it('fails closed before exact follow for unavailable or malformed provider-session targets', async () => {
        const resolveTarget = vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'plugin_external_follow_identity_ambiguous',
        }));
        const followExecute = vi.fn();
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            takeoverOperation: null,
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
            takeoverOperation: null,
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
        const takeoverExecute = vi.fn(async () => Object.freeze({
            sessionId: 'linked-1',
            status: 'takenOver' as const,
        }));
        const followExecute = vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'test_unavailable',
        }));
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            takeoverOperation: unavailableTakeoverOperation(takeoverExecute),
            followOperation: unavailableFollowOperation(followExecute),
        });
        let accountRevision: string | null = 'account-1';
        const binding = owner.bind(createBindingInput());

        await binding.executeTakeover(takeoverRequest());
        await binding.executeFollow(followRequest());

        expect(takeoverExecute).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.plugin',
            contributionId: 'codex',
            generationId: 'generation-1',
            sessionId: 'session-1',
            machineId: 'machine-1',
            accountRevision: 'account-1',
            isCurrent: expect.any(Function),
        }));
        expect(followExecute).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.plugin',
            contributionId: 'codex',
            generationId: 'generation-1',
            machineId: 'machine-1',
            isCurrent: expect.any(Function),
        }));

        const foreignRef = { ...ref, agentId: 'claude' };
        await expect(binding.executeTakeover({
            ...takeoverRequest(),
            ref: foreignRef,
        })).rejects.toMatchObject({
            code: 'plugin_external_takeover_identity_mismatch',
        });
        await expect(binding.executeFollow({
            ...followRequest(),
            ref: foreignRef,
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_identity_mismatch',
        });
        expect(takeoverExecute).toHaveBeenCalledTimes(1);
        expect(followExecute).toHaveBeenCalledTimes(1);

        const accountScopedBinding = owner.bind(createBindingInput({
            readAccountRevision: () => accountRevision,
        }));
        accountRevision = 'account-2';
        await expect(
            accountScopedBinding.executeTakeover(takeoverRequest()),
        ).rejects.toMatchObject({
            code: 'plugin_generation_retired',
        });
        await expect(
            accountScopedBinding.executeFollow(followRequest()),
        ).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(takeoverExecute).toHaveBeenCalledTimes(1);
        expect(followExecute).toHaveBeenCalledTimes(1);
    });

    it('invalidates every old binding on replacement and a stale install dispose cannot retire the replacement', async () => {
        const firstTakeover = vi.fn();
        const firstFollow = vi.fn();
        const replacementTakeover = vi.fn(async () => Object.freeze({
            sessionId: 'replacement-linked',
            status: 'takenOver' as const,
        }));
        const replacementFollow = vi.fn(async () => Object.freeze({
            status: 'unavailable' as const,
            code: 'replacement',
        }));
        const owner = createExternalSessionHostOperationOwner();
        const firstInstallation = await installOperations(owner, {
            takeoverOperation: unavailableTakeoverOperation(firstTakeover),
            followOperation: unavailableFollowOperation(firstFollow),
        });
        const oldBinding = owner.bind(createBindingInput());

        await installOperations(owner, {
            takeoverOperation: unavailableTakeoverOperation(replacementTakeover),
            followOperation: unavailableFollowOperation(replacementFollow),
        });
        await firstInstallation.dispose();

        await expect(oldBinding.executeTakeover(takeoverRequest())).rejects.toMatchObject({
            code: 'plugin_generation_retired',
        });
        await expect(oldBinding.executeFollow(followRequest())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(firstTakeover).not.toHaveBeenCalled();
        expect(firstFollow).not.toHaveBeenCalled();
        expect(replacementTakeover).not.toHaveBeenCalled();
        expect(replacementFollow).not.toHaveBeenCalled();

        const replacementBinding = owner.bind(createBindingInput({
            generationId: 'generation-2',
            sessionId: 'session-2',
        }));
        await replacementBinding.executeTakeover(takeoverRequest());
        await replacementBinding.executeFollow(followRequest());
        expect(replacementTakeover).toHaveBeenCalledOnce();
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
                takeoverOperation: null,
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
                takeoverOperation: null,
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
                takeoverOperation: null,
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
                takeoverOperation: null,
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

    it('rejects retirement before takeover commit but does not relabel a committed success', async () => {
        let resolveLink!: (value: Readonly<{ ok: true; sessionId: string }>) => void;
        const linkPending = new Promise<Readonly<{ ok: true; sessionId: string }>>((resolve) => {
            resolveLink = resolve;
        });
        const takeover = vi.fn(async () => ({
            ok: true as const,
            sessionId: 'linked-before',
            takeoverStatus: 'takenOver' as const,
        }));
        const operation = createExternalSessionTakeoverHostOperation({
            ensureLink: async () => await linkPending,
            takeover,
        });
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            takeoverOperation: operation,
            followOperation: null,
        });
        const beforeCommit = owner.bind(createBindingInput());
        const pendingBeforeCommit = beforeCommit.executeTakeover(takeoverRequest());
        await installOperations(owner, {
            takeoverOperation: unavailableTakeoverOperation(),
            followOperation: null,
        });
        resolveLink({ ok: true, sessionId: 'linked-before' });
        await expect(pendingBeforeCommit).rejects.toBeInstanceOf(PluginError);
        expect(takeover).not.toHaveBeenCalled();

        let resolveTakeover!: (value: Readonly<{
            ok: true;
            sessionId: string;
            takeoverStatus: 'attached';
        }>) => void;
        const takeoverPending = new Promise<Readonly<{
            ok: true;
            sessionId: string;
            takeoverStatus: 'attached';
        }>>((resolve) => {
            resolveTakeover = resolve;
        });
        const committedTakeover = vi.fn(async () => await takeoverPending);
        const committedOperation = createExternalSessionTakeoverHostOperation({
            ensureLink: async () => ({ ok: true, sessionId: 'linked-committed' }),
            takeover: committedTakeover,
        });
        await installOperations(owner, {
            takeoverOperation: committedOperation,
            followOperation: null,
        });
        const afterCommit = owner.bind(createBindingInput({
            generationId: 'generation-3',
            sessionId: 'session-3',
        }));
        const pendingAfterCommit = afterCommit.executeTakeover(takeoverRequest());
        await vi.waitFor(() => expect(committedTakeover).toHaveBeenCalledOnce());
        await installOperations(owner, {
            takeoverOperation: unavailableTakeoverOperation(),
            followOperation: null,
        });
        resolveTakeover({
            ok: true,
            sessionId: 'linked-committed',
            takeoverStatus: 'attached',
        });
        await expect(pendingAfterCommit).resolves.toEqual({
            sessionId: 'linked-committed',
            status: 'attached',
        });
    });

    it('rejects caller cancellation before takeover commit but awaits and preserves a post-commit success', async () => {
        let resolveLink!: (value: Readonly<{ ok: true; sessionId: string }>) => void;
        const linkPending = new Promise<Readonly<{
            ok: true;
            sessionId: string;
        }>>((resolve) => {
            resolveLink = resolve;
        });
        const takeover = vi.fn(async () => ({
            ok: true as const,
            sessionId: 'linked-before',
            takeoverStatus: 'takenOver' as const,
        }));
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            takeoverOperation: createExternalSessionTakeoverHostOperation({
                ensureLink: async () => await linkPending,
                takeover,
            }),
            followOperation: null,
        });
        const beforeCommit = owner.bind(createBindingInput());
        const preCommitCaller = new AbortController();
        const pendingBeforeCommit = beforeCommit.executeTakeover(
            takeoverRequest(preCommitCaller.signal),
        );
        preCommitCaller.abort();
        resolveLink({ ok: true, sessionId: 'linked-before' });
        await expect(pendingBeforeCommit).rejects.toMatchObject({
            code: 'plugin_operation_aborted',
        });
        expect(takeover).not.toHaveBeenCalled();

        let resolveTakeover!: (value: Readonly<{
            ok: true;
            sessionId: string;
            takeoverStatus: 'attached';
        }>) => void;
        const takeoverPending = new Promise<Readonly<{
            ok: true;
            sessionId: string;
            takeoverStatus: 'attached';
        }>>((resolve) => {
            resolveTakeover = resolve;
        });
        const committedTakeover = vi.fn(async () => await takeoverPending);
        await installOperations(owner, {
            takeoverOperation: createExternalSessionTakeoverHostOperation({
                ensureLink: async () => ({
                    ok: true,
                    sessionId: 'linked-committed',
                }),
                takeover: committedTakeover,
            }),
            followOperation: null,
        });
        const afterCommit = owner.bind(createBindingInput({
            generationId: 'generation-2',
            sessionId: 'session-2',
        }));
        const postCommitCaller = new AbortController();
        const pendingAfterCommit = afterCommit.executeTakeover(
            takeoverRequest(postCommitCaller.signal),
        );
        await vi.waitFor(() => expect(committedTakeover).toHaveBeenCalledOnce());
        postCommitCaller.abort();
        resolveTakeover({
            ok: true,
            sessionId: 'linked-committed',
            takeoverStatus: 'attached',
        });
        await expect(pendingAfterCommit).resolves.toEqual({
            sessionId: 'linked-committed',
            status: 'attached',
        });
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
            takeoverOperation: null,
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

    it('bounds active follows per bound session and rejects oversized events without retiring siblings', async () => {
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
            takeoverOperation: null,
            followOperation: unavailableFollowOperation(followExecute),
        });
        const binding = owner.bind(createBindingInput());
        const follows = [];
        for (let index = 0; index < 64; index += 1) {
            follows.push(await binding.executeFollow(followRequest()));
        }
        await expect(binding.executeFollow(followRequest())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_external_follow_limit_exceeded',
        });
        expect(followExecute).toHaveBeenCalledTimes(64);

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

    it('admits no new work after daemon-owner retirement', async () => {
        const takeoverExecute = vi.fn();
        const followExecute = vi.fn();
        const owner = createExternalSessionHostOperationOwner();
        await installOperations(owner, {
            takeoverOperation: unavailableTakeoverOperation(takeoverExecute),
            followOperation: unavailableFollowOperation(followExecute),
        });
        await owner.retire();
        const binding = owner.bind(createBindingInput());

        await expect(binding.executeTakeover(takeoverRequest())).rejects.toMatchObject({
            code: 'plugin_generation_retired',
        });
        await expect(binding.executeFollow(followRequest())).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_generation_retired',
        });
        expect(takeoverExecute).not.toHaveBeenCalled();
        expect(followExecute).not.toHaveBeenCalled();
        await expect(owner.install({
            takeoverOperation: unavailableTakeoverOperation(),
            followOperation: unavailableFollowOperation(),
        })).rejects.toThrow('External Session host-operation owner is retired');
    });
});
