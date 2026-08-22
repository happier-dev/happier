import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    writeSessionStateFieldToMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import type {
    ExternalAgentObservationLeafFactV1,
    ExternalAgentObservationLinkEvidenceBatchV1,
    ExternalAgentObservationSnapshotV1,
    ExternalAgentObservationTargetV1,
} from '@happier-dev/protocol';

import { createExternalSessionObservationReconciler } from './createExternalSessionObservationReconciler';
import { createExternalSessionObservationProjection } from './createExternalSessionObservationProjection';

const { debugLog } = vi.hoisted(() => ({
    debugLog: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: debugLog,
    },
}));

type PublishField = (input: Readonly<{
    sessionId: string;
    fieldId: 'runtime.externalAgent';
    value: ExternalAgentObservationSnapshotV1;
}>) => Promise<void>;

function target(linkGeneration = 'link-generation-1'): ExternalAgentObservationTargetV1 {
    return {
        qualifiedLinkIdentity: {
            v: 1,
            agent: {
                pluginId: 'happier.opencode',
                localId: 'opencode',
            },
            source: {
                kind: 'opencode.server',
                contractVersion: 1,
            },
        },
        linkGeneration,
    };
}

function workingFact(observedAtMs = 1_000, expiresAtMs = 2_000):
ExternalAgentObservationLeafFactV1 {
    return {
        kind: 'turn_phase',
        evidenceClass: 'agent_native',
        value: 'working',
        observedAtMs,
        expiresAtMs,
    };
}

function idleFact(observedAtMs = 1_100, expiresAtMs = 2_100):
ExternalAgentObservationLeafFactV1 {
    return {
        kind: 'turn_phase',
        evidenceClass: 'agent_native',
        value: 'idle',
        observedAtMs,
        expiresAtMs,
    };
}

function qualifiedWorkingFact(
    observedAtMs = 1_000,
    expiresAtMs = 2_000,
): ExternalAgentObservationLeafFactV1 {
    return {
        kind: 'turn_phase',
        evidenceClass: 'qualified_hook',
        value: 'working',
        observedAtMs,
        expiresAtMs,
    };
}

function batch(
    linkKey: string,
    ...facts: ExternalAgentObservationLeafFactV1[]
): ExternalAgentObservationLinkEvidenceBatchV1 {
    return {
        items: [{
            linkKey,
            facts,
        }],
    };
}

function observationLinkInput(linkGeneration = 'link-generation-1') {
    return {
        resource: {
            pluginId: 'happier.opencode',
            agentLocalId: 'opencode',
            pluginGeneration: 'plugin-generation-1',
            resourceKey: 'endpoint-one',
        },
        link: {
            sessionId: 'session-1',
            linkGeneration,
            linkKey: 'native-session-1',
            linkedSource: {
                source: { kind: 'opencode.server' },
                remoteSessionId: 'native-session-1',
                linkData: {},
            },
            changeObservation: 'observe_resource',
        },
        target: target(linkGeneration),
    } as const;
}

function setup(
    retirementSignal?: AbortSignal,
    observerDispose = vi.fn(async () => {}),
) {
    let emit: ((value: ExternalAgentObservationLinkEvidenceBatchV1) => void) | null = null;
    const acquireObserver = vi.fn(async (input: Readonly<{
        emit(value: ExternalAgentObservationLinkEvidenceBatchV1): void;
    }>) => {
        emit = input.emit;
        return { dispose: observerDispose };
    });
    const reconciler = createExternalSessionObservationReconciler({
        acquireObserver: acquireObserver as never,
    });
    const publishField = vi.fn<PublishField>(async () => {});
    const projection = createExternalSessionObservationProjection({
        reconciler,
        publishField,
        now: Date.now,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
    });
    const reconcile = async (overrides?: Readonly<{
        linkGeneration?: string;
        linkKey?: string;
    }>) => projection.reconcileLink({
        ...observationLinkInput(overrides?.linkGeneration),
        resource: {
            ...observationLinkInput(overrides?.linkGeneration).resource,
            ...(retirementSignal ? { retirementSignal } : {}),
        },
        link: {
            ...observationLinkInput(overrides?.linkGeneration).link,
            linkKey: overrides?.linkKey ?? 'native-session-1',
        },
        demand: {
            passiveEvent: true,
            persistedPolicy: false,
            fallbackDemand: false,
        },
    });
    return {
        projection,
        reconciler,
        acquireObserver,
        publishField,
        observerDispose,
        emit(value: ExternalAgentObservationLinkEvidenceBatchV1) {
            if (!emit) throw new Error('Observer was not acquired');
            emit(value);
        },
        reconcile,
    };
}

afterEach(() => {
    vi.useRealTimers();
    debugLog.mockClear();
});

describe('createExternalSessionObservationProjection', () => {
    it('changes only fallback demand while preserving passive and persisted axes', async () => {
        const owner = setup();
        await owner.projection.reconcileLink({
            ...observationLinkInput(),
            demand: {
                passiveEvent: true,
                persistedPolicy: true,
                fallbackDemand: false,
            },
        });
        const reconcileLink = vi.spyOn(owner.reconciler, 'reconcileLink');
        reconcileLink.mockClear();

        await owner.projection.reconcileFallbackDemandBatch([{
            sessionId: 'session-1',
            linkGeneration: 'link-generation-1',
            resolved: observationLinkInput(),
            demanded: true,
        }]);
        expect(reconcileLink).toHaveBeenLastCalledWith(expect.objectContaining({
            demand: {
                passiveEvent: true,
                persistedPolicy: true,
                fallbackDemand: true,
            },
        }));

        await owner.projection.reconcileFallbackDemandBatch([{
            sessionId: 'session-1',
            linkGeneration: 'link-generation-1',
            resolved: null,
            demanded: false,
        }]);
        expect(reconcileLink).toHaveBeenLastCalledWith(expect.objectContaining({
            demand: {
                passiveEvent: true,
                persistedPolicy: true,
                fallbackDemand: false,
            },
        }));
        await owner.projection.dispose();
    });

    it.each([
        'fallback-first',
        'passive-first',
    ] as const)(
        'preserves passive and fallback demand across reload when %s refresh lands',
        async (order) => {
            const owner = setup();
            const initial = observationLinkInput();
            const reloaded = {
                ...observationLinkInput(),
                resource: {
                    ...observationLinkInput().resource,
                    pluginGeneration: 'plugin-generation-2',
                },
            };
            const passiveDemand = {
                passiveEvent: true,
                persistedPolicy: true,
                fallbackDemand: false,
            } as const;
            await owner.projection.reconcileLink({
                ...initial,
                demand: passiveDemand,
            });
            await owner.projection.reconcileFallbackDemandBatch([{
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                resolved: initial,
                demanded: true,
            }]);
            const reconcileLink = vi.spyOn(owner.reconciler, 'reconcileLink');
            reconcileLink.mockClear();

            const refreshFallback = async () => {
                await owner.projection.reconcileFallbackDemandBatch([{
                    sessionId: 'session-1',
                    linkGeneration: 'link-generation-1',
                    resolved: reloaded,
                    demanded: true,
                }]);
            };
            const restorePassive = async () => {
                await owner.projection.reconcileLink({
                    ...reloaded,
                    demand: passiveDemand,
                });
            };
            if (order === 'fallback-first') {
                await refreshFallback();
                await restorePassive();
            } else {
                await restorePassive();
                await refreshFallback();
            }

            expect(reconcileLink).toHaveBeenLastCalledWith(expect.objectContaining({
                resource: expect.objectContaining({
                    pluginGeneration: 'plugin-generation-2',
                }),
                demand: {
                    passiveEvent: true,
                    persistedPolicy: true,
                    fallbackDemand: true,
                },
            }));
            expect(owner.acquireObserver).toHaveBeenCalledTimes(2);
            expect(owner.observerDispose).toHaveBeenCalledTimes(1);

            await owner.projection.dispose();
            expect(owner.observerDispose).toHaveBeenCalledTimes(2);
        },
    );

    it('keeps an unchanged runtime refresh on the current observer without duplicate publication', async () => {
        const owner = setup();
        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact()));
        await vi.waitFor(() => {
            expect(owner.publishField).toHaveBeenCalledTimes(1);
        });

        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();

        expect(owner.acquireObserver).toHaveBeenCalledTimes(1);
        expect(owner.observerDispose).not.toHaveBeenCalled();
        expect(owner.publishField).toHaveBeenCalledTimes(1);

        await owner.projection.dispose();
        expect(owner.observerDispose).toHaveBeenCalledTimes(1);
    });

    it('keeps observer acquisition failure scoped to observation and reacquires the same link without an offline publication', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const observerCallbacks: {
            emit?: (value: ExternalAgentObservationLinkEvidenceBatchV1) => void;
        } = {};
        const observerDispose = vi.fn(async () => {});
        const acquireObserver = vi.fn()
            .mockRejectedValueOnce(new Error('observer unavailable'))
            .mockImplementationOnce(async (input: Readonly<{
                emit(value: ExternalAgentObservationLinkEvidenceBatchV1): void;
            }>) => {
                observerCallbacks.emit = input.emit;
                return { dispose: observerDispose };
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: acquireObserver as never,
        });
        const publishField = vi.fn<PublishField>(async () => {});
        const projection = createExternalSessionObservationProjection({
            reconciler,
            publishField,
        });
        const input = {
            ...observationLinkInput(),
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            },
        } as const;

        await expect(projection.reconcileLink(input))
            .rejects.toThrow('observer unavailable');
        expect(publishField).not.toHaveBeenCalled();

        await expect(projection.reconcileLink(input))
            .resolves.toEqual({ state: 'observing' });
        const emit = observerCallbacks.emit;
        if (!emit) throw new Error('Observer was not reacquired');
        emit(batch('native-session-1', workingFact()));
        await projection.flush();

        expect(acquireObserver).toHaveBeenCalledTimes(2);
        expect(publishField).toHaveBeenCalledOnce();
        expect(publishField).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: expect.objectContaining({
                status: 'working',
                linkGeneration: 'link-generation-1',
            }),
        }));

        await projection.dispose();
        expect(observerDispose).toHaveBeenCalledOnce();
    });

    it('admits each fallback batch before one shared-resource reconciliation without observer churn', async () => {
        const acquireObserver = vi.fn(async () => ({
            dispose: async () => {},
        }));
        const reconcileResource = vi.fn(async (input: Readonly<{
            links: readonly Readonly<{ linkKey: string }>[];
        }>) => ({
            purpose: 'observation_evidence' as const,
            outcomes: input.links.map((link) => ({
                linkKey: link.linkKey,
                facts: [],
            })),
        }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            reconcileResource,
        });
        const projection = createExternalSessionObservationProjection({
            reconciler,
            publishField: vi.fn(async () => {}),
        });
        const first = observationLinkInput();
        const second = {
            ...observationLinkInput('link-generation-2'),
            link: {
                ...observationLinkInput('link-generation-2').link,
                sessionId: 'session-2',
                linkKey: 'native-session-2',
                linkedSource: {
                    source: { kind: 'opencode.server' as const },
                    remoteSessionId: 'native-session-2',
                    linkData: {},
                },
            },
        };

        await projection.reconcileFallbackDemandBatch([
            {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                resolved: first,
                demanded: true,
            },
            {
                sessionId: 'session-2',
                linkGeneration: 'link-generation-2',
                resolved: second,
                demanded: true,
            },
        ]);

        expect(reconcileResource).toHaveBeenCalledOnce();
        expect(reconcileResource.mock.calls[0]?.[0].links.map((link) => link.linkKey).sort())
            .toEqual(['native-session-1', 'native-session-2']);

        await projection.reconcileFallbackDemandBatch([
            {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                resolved: first,
                demanded: true,
            },
            {
                sessionId: 'session-2',
                linkGeneration: 'link-generation-2',
                resolved: second,
                demanded: true,
            },
        ]);

        expect(acquireObserver).not.toHaveBeenCalled();
        expect(reconcileResource).toHaveBeenCalledTimes(2);
        await projection.dispose();
    });

    it.each(['status', 'fallback'] as const)(
        'keeps %s-only demand out of descriptor hydration',
        async (surface) => {
            const reconcileResource = vi.fn(async (input: Readonly<{
                purpose: 'observation_evidence' | 'resource_descriptors';
                links: readonly Readonly<{ linkKey: string }>[];
            }>) => {
                if (input.purpose === 'resource_descriptors') {
                    throw new TypeError('unauthorized file set');
                }
                return {
                    purpose: input.purpose,
                    outcomes: input.links.map((link) => ({
                        linkKey: link.linkKey,
                        facts: [],
                    })),
                };
            });
            const reconciler = createExternalSessionObservationReconciler({
                acquireObserver: vi.fn(async () => ({
                    dispose: async () => {},
                })),
                reconcileResource,
            });
            const projection = createExternalSessionObservationProjection({
                reconciler,
                publishField: vi.fn(async () => {}),
            });
            const groupingOnly = {
                ...observationLinkInput(),
                link: {
                    ...observationLinkInput().link,
                    changeObservation: undefined,
                },
            };

            const reconciliation = surface === 'status'
                ? projection.reconcileStatusLink(groupingOnly)
                : projection.reconcileFallbackDemandBatch([{
                    sessionId: groupingOnly.link.sessionId,
                    linkGeneration: groupingOnly.link.linkGeneration,
                    resolved: groupingOnly,
                    demanded: true,
                }]);

            await reconciliation;
            expect(reconcileResource.mock.calls.map(
                ([request]) => request.purpose,
            )).toEqual(['observation_evidence']);
            await projection.dispose();
        },
    );

    it('attaches the current qualified target, reduces admitted facts, and publishes one canonical field change', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();

        expect(owner.publishField).toHaveBeenCalledTimes(1);
        expect(owner.publishField).toHaveBeenCalledWith({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                v: 1,
                ...target(),
                status: 'working',
                observedAtMs: 1_000,
                expiresAtMs: 2_000,
            },
        });

        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();
        expect(owner.publishField).toHaveBeenCalledTimes(1);

        await owner.projection.dispose();
    });

    it('reduces one admitted multi-axis evidence batch before publishing its semantic state', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.reconcile();

        owner.emit(batch(
            'native-session-1',
            {
                kind: 'liveness',
                evidenceClass: 'agent_native',
                value: 'running',
                observedAtMs: 980,
                expiresAtMs: 2_000,
            },
            {
                kind: 'turn_phase',
                evidenceClass: 'agent_native',
                value: 'waiting',
                observedAtMs: 990,
                expiresAtMs: 2_000,
            },
            {
                kind: 'completed_boundary',
                evidenceClass: 'agent_native',
                boundaryId: 'turn-17',
                observedAtMs: 995,
            },
        ));
        await owner.projection.flush();

        expect(owner.publishField).toHaveBeenCalledTimes(1);
        expect(owner.publishField).toHaveBeenCalledWith({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                v: 1,
                ...target(),
                status: 'waiting',
                observedAtMs: 990,
                expiresAtMs: 2_000,
                boundary: {
                    id: 'turn-17',
                    observedAtMs: 995,
                },
            },
        });

        await owner.projection.dispose();
    });

    it('admits qualified hook facts only through the current link record and canonical reducer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.reconcile();

        await expect(owner.projection.admitQualifiedFacts({
            sessionId: 'session-1',
            target: target(),
            facts: [qualifiedWorkingFact()],
        })).resolves.toBe(true);
        await owner.projection.flush();

        expect(owner.publishField).toHaveBeenCalledWith({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                v: 1,
                ...target(),
                status: 'working',
                observedAtMs: 1_000,
                expiresAtMs: 2_000,
            },
        });

        await expect(owner.projection.admitQualifiedFacts({
            sessionId: 'session-1',
            target: target('replaced-link-generation'),
            facts: [qualifiedWorkingFact(1_100, 2_100)],
        })).resolves.toBe(false);
        expect(owner.projection.readSnapshot('session-1')).toMatchObject({
            linkGeneration: 'link-generation-1',
            observedAtMs: 1_000,
        });

        await owner.projection.dispose();
    });

    it('admits a durable current-link hook fact without observation or transcript demand', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        const projection = owner.projection as typeof owner.projection & Readonly<{
            admitQualifiedFactsForCurrentLink?(input: Readonly<{
                resolved: ReturnType<typeof observationLinkInput>;
                facts: readonly ReturnType<typeof qualifiedWorkingFact>[];
            }>): Promise<boolean>;
        }>;

        expect(projection.admitQualifiedFactsForCurrentLink).toBeTypeOf('function');
        await expect(projection.admitQualifiedFactsForCurrentLink!({
            resolved: observationLinkInput(),
            facts: [qualifiedWorkingFact()],
        })).resolves.toBe(true);
        await owner.projection.flush();

        expect(owner.acquireObserver).not.toHaveBeenCalled();
        expect(owner.publishField).toHaveBeenCalledWith({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                v: 1,
                ...target(),
                status: 'working',
                observedAtMs: 1_000,
                expiresAtMs: 2_000,
            },
        });

        await owner.projection.dispose();
    });

    it('revalidates hook ingress currentness inside the serialized fact commit', async () => {
        const owner = setup();
        await owner.reconcile();
        owner.publishField.mockClear();

        let releaseBlockingReconcile!: (
            value: Readonly<{ state: 'observing' }>,
        ) => void;
        vi.spyOn(owner.reconciler, 'reconcileLink').mockImplementationOnce(
            async () => await new Promise((resolve) => {
                releaseBlockingReconcile = resolve;
            }),
        );
        const blockingMutation = owner.reconcile();
        await vi.waitFor(() => {
            expect(owner.reconciler.reconcileLink).toHaveBeenCalledOnce();
        });

        let shouldCommit = true;
        const pendingAdmission = owner.projection.admitQualifiedFacts({
            sessionId: 'session-1',
            target: target(),
            facts: [qualifiedWorkingFact()],
            shouldCommit: () => shouldCommit,
        });
        shouldCommit = false;
        releaseBlockingReconcile({ state: 'observing' });

        await expect(blockingMutation).resolves.toEqual({ state: 'observing' });
        await expect(pendingAdmission).resolves.toBe(false);
        await owner.projection.flush();
        expect(owner.publishField).not.toHaveBeenCalled();
        expect(owner.projection.readSnapshot('session-1')).toBeNull();

        await owner.projection.dispose();
    });

    it('resolves only the currently projected qualified link for hook admission', async () => {
        const owner = setup();
        await owner.reconcile();

        expect(owner.projection.resolveQualifiedCurrentLink({
            qualifiedIdentity: target().qualifiedLinkIdentity,
            source: { kind: 'opencode.server' },
            remoteSessionId: 'native-session-1',
            linkData: {},
        })).toEqual({
            sessionId: 'session-1',
            linkGeneration: 'link-generation-1',
        });
        expect(owner.projection.resolveQualifiedCurrentLink({
            qualifiedIdentity: target().qualifiedLinkIdentity,
            source: { kind: 'opencode.server' },
            remoteSessionId: 'different-native-session',
            linkData: {},
        })).toBeNull();

        await owner.projection.dispose();
    });

    it('uses one earliest-expiry timer and publishes the stale-to-unknown transition once', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();
        await vi.advanceTimersByTimeAsync(1_000);
        await owner.projection.flush();

        expect(owner.publishField).toHaveBeenCalledTimes(2);
        expect(owner.publishField).toHaveBeenLastCalledWith({
            sessionId: 'session-1',
            fieldId: 'runtime.externalAgent',
            value: {
                v: 1,
                ...target(),
                status: 'unknown',
            },
        });

        await vi.advanceTimersByTimeAsync(10_000);
        await owner.projection.flush();
        expect(owner.publishField).toHaveBeenCalledTimes(2);

        await owner.projection.dispose();
    });

    it('retains the projection after expiry while transcript follow still demands observation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.projection.reconcileTranscriptDemand({
            resolved: observationLinkInput(),
            demanded: true,
        });

        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();
        await vi.advanceTimersByTimeAsync(1_000);
        await owner.projection.flush();

        expect(owner.projection.readSnapshot('session-1')).toMatchObject({
            status: 'unknown',
        });
        expect(owner.observerDispose).not.toHaveBeenCalled();

        owner.emit(batch('native-session-1', workingFact(2_001, 3_000)));
        await owner.projection.flush();
        expect(owner.projection.readSnapshot('session-1')).toMatchObject({
            status: 'working',
        });

        await owner.projection.dispose();
    });

    it('chunks a very-future expiry within the Node timer ceiling without expiring early', async () => {
        const maxTimerDelayMs = 2_147_483_647;
        let nowMs = 1_000;
        let emit = (_value: ExternalAgentObservationLinkEvidenceBatchV1): void => {
            throw new Error('Observer was not acquired');
        };
        const scheduled: Array<{
            callback: () => void;
            requestedDelayMs: number;
            effectiveDelayMs: number;
        }> = [];
        const setTimer = vi.fn((
            callback: () => void,
            delayMs?: number,
        ) => {
            const requestedDelayMs = delayMs ?? 0;
            scheduled.push({
                callback,
                requestedDelayMs,
                effectiveDelayMs: requestedDelayMs > maxTimerDelayMs
                    ? 1
                    : requestedDelayMs,
            });
            return { scheduled: scheduled.length };
        }) as unknown as typeof setTimeout;
        const clearTimer = vi.fn() as unknown as typeof clearTimeout;
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                emit = input.emit;
                return { dispose() {} };
            }),
        });
        const publishField = vi.fn<PublishField>(async () => {});
        const projection = createExternalSessionObservationProjection({
            reconciler,
            publishField,
            now: () => nowMs,
            setTimer,
            clearTimer,
        });
        await projection.reconcileLink({
            ...observationLinkInput(),
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            },
        });

        emit(batch(
            'native-session-1',
            workingFact(nowMs, nowMs + maxTimerDelayMs + 100),
        ));
        await projection.flush();

        const first = scheduled.shift();
        expect(first?.requestedDelayMs).toBe(maxTimerDelayMs);
        if (!first) throw new Error('Expiry timer was not scheduled');
        nowMs += first.effectiveDelayMs;
        first.callback();
        await projection.flush();

        const second = scheduled.shift();
        expect(second?.requestedDelayMs).toBe(100);
        expect(publishField).toHaveBeenCalledTimes(1);
        expect(publishField.mock.calls[0]?.[0].value.status).toBe('working');

        await projection.dispose();
    });

    it('retries a transient canonical publication failure without waiting for another fact', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        owner.publishField
            .mockRejectedValueOnce(new Error('temporary metadata failure'))
            .mockResolvedValue(undefined);
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();
        expect(owner.publishField).toHaveBeenCalledTimes(1);

        await vi.advanceTimersToNextTimerAsync();
        await owner.projection.flush();

        expect(owner.publishField).toHaveBeenCalledTimes(2);
        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'working']);
        await owner.projection.dispose();
    });

    it('does not serialize publication failure details into its log sink', async () => {
        const sentinel = '/var/private/external-session.db TOKEN_SECRET transcript-secret claim-secret';
        const owner = setup();
        owner.publishField.mockRejectedValueOnce({
            message: sentinel,
            cause: { request: sentinel },
            source: { path: sentinel },
            link: { claim: sentinel },
            transcript: sentinel,
        });
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();

        expect(debugLog).toHaveBeenCalledWith(
            '[externalSessions][internal_error]',
            {
                context: 'external_session.observation_publication',
                errorCode: 'internal_error',
                errorKind: 'non_error',
            },
        );
        expect(JSON.stringify(debugLog.mock.calls)).not.toContain(sentinel);
        await owner.projection.dispose();
    });

    it('coalesces a failed publication to the latest semantic value before retry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        owner.publishField
            .mockRejectedValueOnce(new Error('temporary metadata failure'))
            .mockResolvedValue(undefined);
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();
        owner.emit(batch('native-session-1', idleFact(1_100, 10_000)));
        await owner.projection.flush();

        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'idle']);

        await vi.advanceTimersByTimeAsync(1_000);
        await owner.projection.flush();
        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'idle']);
        await owner.projection.dispose();
    });

    it('cancels a failed publication retry when the projection is disposed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        owner.publishField.mockRejectedValueOnce(
            new Error('temporary metadata failure'),
        );
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();
        await owner.projection.dispose();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(owner.publishField).toHaveBeenCalledTimes(1);
    });

    it('replaces a failed publication retry with one fail-closed unknown when the link retires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        owner.publishField
            .mockRejectedValueOnce(new Error('temporary metadata failure'))
            .mockResolvedValue(undefined);
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();
        await owner.projection.removeLink(observationLinkInput().link);
        await owner.projection.flush();

        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'unknown']);

        await vi.advanceTimersByTimeAsync(5_000);
        await owner.projection.flush();
        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'unknown']);
        await owner.projection.dispose();
    });

    it('retries a failed fail-closed unknown publication after the link retires', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        owner.publishField
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('temporary metadata failure'))
            .mockResolvedValue(undefined);
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();
        await owner.projection.removeLink(observationLinkInput().link);
        await owner.projection.flush();

        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'unknown']);

        await vi.advanceTimersByTimeAsync(250);
        await owner.projection.flush();

        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'unknown', 'unknown']);
        await owner.projection.dispose();
    });

    it('releases account-scope custody without overwriting the last durable observation', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        owner.publishField.mockRejectedValueOnce(
            new Error('temporary metadata failure'),
        );
        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();

        await owner.projection.releaseLink(observationLinkInput().link);
        await owner.projection.flush();
        owner.emit(batch('native-session-1', workingFact(2_000, 20_000)));
        await vi.advanceTimersByTimeAsync(10_000);
        await owner.projection.flush();

        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working']);
        expect(owner.projection.readSnapshot('session-1')).toBeNull();
        expect(owner.observerDispose).toHaveBeenCalledOnce();
        await owner.projection.dispose();
    });

    it('fails a tracked observation closed when its generation retires before local release', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const retirement = new AbortController();
        const owner = setup(retirement.signal);
        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();

        retirement.abort();
        await owner.projection.releaseLink(observationLinkInput().link);
        await owner.projection.flush();

        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'unknown']);
        expect(owner.projection.readSnapshot('session-1')).toBeNull();
        expect(owner.observerDispose).toHaveBeenCalledOnce();
        await owner.projection.dispose();
    });

    it('fails closed when generation retirement lands during local observer disposal', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const retirement = new AbortController();
        let finishDisposal!: () => void;
        const disposalBarrier = new Promise<void>((resolve) => {
            finishDisposal = resolve;
        });
        const disposalStarted = vi.fn();
        const observerDispose = vi.fn(async () => {
            disposalStarted();
            await disposalBarrier;
        });
        const owner = setup(retirement.signal, observerDispose);
        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();

        const release = owner.projection.releaseLink(
            observationLinkInput().link,
        );
        await vi.waitFor(() => {
            expect(disposalStarted).toHaveBeenCalledOnce();
        });
        retirement.abort();
        finishDisposal();
        await release;
        await owner.projection.flush();
        owner.emit(batch('native-session-1', workingFact(2_000, 20_000)));
        await vi.advanceTimersByTimeAsync(10_000);
        await owner.projection.flush();

        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'unknown']);
        expect(owner.projection.readSnapshot('session-1')).toBeNull();
        expect(observerDispose).toHaveBeenCalledOnce();
        await owner.projection.dispose();
    });

    it('bounds retries when the canonical publication owner remains unavailable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        owner.publishField.mockRejectedValue(
            new Error('persistent metadata failure'),
        );
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact(1_000, 10_000)));
        await owner.projection.flush();
        await vi.advanceTimersByTimeAsync(6_000);
        await owner.projection.flush();

        expect(owner.publishField).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1_000);
        await owner.projection.flush();
        expect(owner.publishField).toHaveBeenCalledTimes(4);
        await owner.projection.dispose();
    });

    it('serializes semantic publications per session so later state cannot overtake earlier state', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        let releaseFirst: () => void = () => {};
        const firstPublication = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        owner.publishField
            .mockImplementationOnce(async () => await firstPublication)
            .mockResolvedValue(undefined);
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact()));
        await Promise.resolve();
        await Promise.resolve();
        owner.emit(batch('native-session-1', idleFact()));
        await Promise.resolve();
        await Promise.resolve();

        expect(owner.publishField).toHaveBeenCalledTimes(1);
        releaseFirst();
        await owner.projection.flush();

        expect(owner.publishField).toHaveBeenCalledTimes(2);
        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'idle']);
        await owner.projection.dispose();
    });

    it('coalesces an identical snapshot that arrives while its canonical write is pending', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        let releaseFirst: () => void = () => {};
        owner.publishField.mockImplementationOnce(async () => await new Promise<void>(
            (resolve) => {
                releaseFirst = resolve;
            },
        ));
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact()));
        await Promise.resolve();
        await Promise.resolve();
        owner.emit(batch('native-session-1', workingFact()));
        releaseFirst();
        await owner.projection.flush();

        expect(owner.publishField).toHaveBeenCalledTimes(1);
        await owner.projection.dispose();
    });

    it('keeps the last reduction through expiry after demand is removed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();

        await owner.projection.reconcileLink({
            resource: {
                pluginId: 'happier.opencode',
                agentLocalId: 'opencode',
                pluginGeneration: 'plugin-generation-1',
                resourceKey: 'endpoint-one',
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                linkKey: 'native-session-1',
                linkedSource: {
                    source: { kind: 'opencode.server' },
                    remoteSessionId: 'native-session-1',
                    linkData: {},
                },
                changeObservation: 'observe_resource',
            },
            target: target(),
            demand: {
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: false,
            },
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await owner.projection.flush();

        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['working', 'unknown']);
        await owner.projection.dispose();
    });

    it('releases settled publication state after its projection record is removed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.reconcile();
        owner.emit(batch('native-session-1', {
            kind: 'retrieval_failed',
            evidenceClass: 'reconciliation',
            observedAtMs: 1_000,
            axis: 'turn_phase',
        }));
        await owner.projection.flush();

        await owner.projection.removeLink(observationLinkInput().link);
        await owner.projection.flush();
        const releasedSnapshot = owner.publishField.mock.calls.at(-1)?.[0].value;
        if (!releasedSnapshot || releasedSnapshot.status !== 'unknown') {
            throw new Error('Expected the removed record to publish unknown');
        }
        let releasedSnapshotReads = 0;
        Object.defineProperty(releasedSnapshot, 'status', {
            configurable: true,
            enumerable: true,
            get() {
                releasedSnapshotReads += 1;
                return 'unknown';
            },
        });

        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact(1_100, 2_100)));
        await owner.projection.flush();

        expect(releasedSnapshotReads).toBe(0);
        expect(owner.publishField.mock.calls.map(([call]) => call.value.status))
            .toEqual(['unknown', 'working']);
        await owner.projection.dispose();
    });

    it('fences unknown keys and relinked callbacks before publication', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.reconcile();

        owner.emit(batch('unknown-native-session', workingFact()));
        await owner.projection.flush();
        expect(owner.publishField).not.toHaveBeenCalled();

        await owner.reconcile({
            linkGeneration: 'link-generation-2',
            linkKey: 'native-session-2',
        });
        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();
        expect(owner.publishField).not.toHaveBeenCalled();

        await owner.projection.dispose();
    });

    it('publishes only runtime.externalAgent and preserves hosted, Pending, and control metadata', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        let metadata: Record<string, unknown> = {
            presence: 'offline',
            active: false,
            thinking: false,
            latestTurnStatus: 'idle',
            pendingQueueV1: { count: 3 },
            controlConnectivityV1: { status: 'offline' },
        };
        const owner = setup();
        owner.publishField.mockImplementation(async (input) => {
            metadata = writeSessionStateFieldToMetadata(
                metadata,
                input.fieldId,
                input.value,
            );
        });
        await owner.reconcile();

        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();

        expect(metadata).toMatchObject({
            presence: 'offline',
            active: false,
            thinking: false,
            latestTurnStatus: 'idle',
            pendingQueueV1: { count: 3 },
            controlConnectivityV1: { status: 'offline' },
            externalAgentObservationV1: {
                status: 'working',
            },
        });

        await owner.projection.dispose();
    });

    it('disposal clears the scheduler and releases the pooled resource once', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact()));
        await owner.projection.flush();

        await owner.projection.dispose();
        await owner.projection.dispose();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(owner.observerDispose).toHaveBeenCalledTimes(1);
        expect(owner.publishField).toHaveBeenCalledTimes(1);
    });

    it('fences queued publications on disposal while awaiting an in-flight canonical write', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const owner = setup();
        let releaseFirst: () => void = () => {};
        owner.publishField.mockImplementationOnce(async () => await new Promise<void>((resolve) => {
            releaseFirst = resolve;
        }));
        await owner.reconcile();
        owner.emit(batch('native-session-1', workingFact()));
        await Promise.resolve();
        await Promise.resolve();
        owner.emit(batch('native-session-1', idleFact()));

        const disposal = owner.projection.dispose();
        releaseFirst();
        await disposal;

        expect(owner.publishField).toHaveBeenCalledTimes(1);
    });

    it('removes temporary status demand when reconciliation fails', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const reconcileResource = vi.fn(async () => {
            throw new Error('leaf reconciliation failed');
        });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(),
            reconcileResource,
        });
        const removeLink = vi.spyOn(reconciler, 'removeLink');
        const publishField = vi.fn<PublishField>(async () => {});
        const projection = createExternalSessionObservationProjection({
            reconciler,
            publishField,
        });

        await expect(projection.reconcileStatusLink({
            resource: {
                pluginId: 'happier.opencode',
                agentLocalId: 'opencode',
                pluginGeneration: 'plugin-generation-1',
                resourceKey: 'endpoint-one',
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                linkKey: 'native-session-1',
                linkedSource: {
                    source: { kind: 'opencode.server' },
                    remoteSessionId: 'native-session-1',
                    linkData: {},
                },
                changeObservation: 'reconcile_only',
            },
            target: target(),
        })).rejects.toThrow('leaf reconciliation failed');

        expect(removeLink).toHaveBeenCalledTimes(1);
        expect(projection.readSnapshot('session-1')).toBeNull();
        expect(publishField).not.toHaveBeenCalled();
        await projection.dispose();
    });
});
