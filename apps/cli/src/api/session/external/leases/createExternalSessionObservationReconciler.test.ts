import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    ExternalAgentObservationLeafFactV1,
    ExternalAgentObservationLinkEvidenceBatchV1,
    ExternalAgentObservationReconcileResultV1,
} from '@happier-dev/protocol';

import {
    createExternalSessionObservationReconciler,
    type ExternalSessionObservationLinkIdentity,
    type ExternalSessionObservationResourceIdentity,
} from './createExternalSessionObservationReconciler';

type TestFact = ExternalAgentObservationLeafFactV1;
type TestBatch = ExternalAgentObservationLinkEvidenceBatchV1;
type TestReconcileResult = ExternalAgentObservationReconcileResultV1;

function fact(boundaryId: string): TestFact {
    return {
        kind: 'completed_boundary',
        evidenceClass: 'agent_native',
        observedAtMs: 1,
        boundaryId,
    };
}

function batch(...entries: ReadonlyArray<readonly [linkKey: string, boundaryId: string]>): TestBatch {
    return {
        items: entries.map(([linkKey, boundaryId]) => ({
            linkKey,
            facts: [fact(boundaryId)],
        })),
    };
}

function result(
    ...entries: ReadonlyArray<readonly [linkKey: string, boundaryId: string]>
): TestReconcileResult {
    return {
        purpose: 'observation_evidence',
        outcomes: entries.map(([linkKey, boundaryId]) => ({
            linkKey,
            facts: [fact(boundaryId)],
        })),
    };
}

function resource(
    overrides?: Partial<ExternalSessionObservationResourceIdentity>,
): ExternalSessionObservationResourceIdentity {
    return {
        pluginId: 'happier-opencode',
        agentLocalId: 'opencode',
        pluginGeneration: '7',
        resourceKey: 'https://one.example\u0000auth-generation-a',
        ...overrides,
    };
}

function demanded(overrides?: Partial<{
    passiveEvent: boolean;
    persistedPolicy: boolean;
    fallbackDemand: boolean;
}>) {
    return {
        passiveEvent: true,
        persistedPolicy: false,
        fallbackDemand: false,
        ...overrides,
    };
}

function link(
    index: number,
    overrides?: Partial<ExternalSessionObservationLinkIdentity>,
): ExternalSessionObservationLinkIdentity {
    return {
        sessionId: `session-${index}`,
        linkGeneration: 'link-1',
        linkKey: `native-${index}`,
        linkedSource: {
            source: { kind: 'test' },
            remoteSessionId: `native-${index}`,
            linkData: {},
        },
        changeObservation: 'observe_resource',
        ...overrides,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('createExternalSessionObservationReconciler', () => {
    it('acquires only the change-observation mechanism declared by each link', async () => {
        const acquireObserver = vi.fn(async () => ({ dispose: async () => {} }));
        const watchFile = vi.fn(() => () => {});
        const reconcileResource = vi.fn(
            async (): Promise<TestReconcileResult> => ({
                purpose: 'observation_evidence',
                outcomes: [],
            }),
        );
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            watchFile,
            reconcileResource,
        });

        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'native-observer' }),
            link: {
                ...link(1),
                changeObservation: 'observe_resource',
            },
            demand: demanded(),
            onFacts: () => {},
        });
        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'watched-files' }),
            link: {
                ...link(2),
                changeObservation: 'watch_file_changes',
                watchFileChanges: { files: ['/tmp/session-2.jsonl'] },
            },
            demand: demanded(),
            onFacts: () => {},
        });
        const reconcileOnlyResource = resource({
            resourceKey: 'reconcile-only',
        });
        await reconciler.reconcileLink({
            resource: reconcileOnlyResource,
            link: {
                ...link(3),
                changeObservation: 'reconcile_only',
            },
            demand: demanded({ fallbackDemand: true }),
            onFacts: () => {},
        });
        await reconciler.reconcileResource(reconcileOnlyResource);

        expect(acquireObserver).toHaveBeenCalledTimes(1);
        expect(watchFile).toHaveBeenCalledTimes(1);
        expect(watchFile).toHaveBeenCalledWith(
            '/tmp/session-2.jsonl',
            expect.any(Function),
            { emitInitial: false },
        );
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            resource: expect.objectContaining({ resourceKey: 'reconcile-only' }),
            links: [expect.objectContaining({ linkKey: 'native-3' })],
        }));

        await reconciler.dispose();
    });

    it('fails closed when one physical resource is described with conflicting dispositions', async () => {
        for (const conflictingDisposition of [
            'watch_file_changes',
            'reconcile_only',
        ] as const) {
            let emit: ((batch: TestBatch) => void) | undefined;
            const acquireObserver = vi.fn(async (input) => {
                emit = input.emit;
                return { dispose: async () => {} };
            });
            const watchFile = vi.fn(() => () => {});
            const acceptedFacts: string[] = [];
            const rejectedFacts: string[] = [];
            const reconciler = createExternalSessionObservationReconciler({
                acquireObserver,
                watchFile,
            });
            const sharedResource = resource({
                resourceKey: `shared-${conflictingDisposition}`,
            });

            await expect(reconciler.reconcileLink({
                resource: sharedResource,
                link: {
                    ...link(1),
                    changeObservation: 'observe_resource',
                },
                demand: demanded(),
                onFacts: (accepted) => acceptedFacts.push(
                    ...accepted.map((fact) => (
                        fact.kind === 'completed_boundary'
                            ? fact.boundaryId
                            : fact.kind
                    )),
                ),
            })).resolves.toEqual({ state: 'observing' });
            await expect(reconciler.reconcileLink({
                resource: sharedResource,
                link: {
                    ...link(2),
                    changeObservation: conflictingDisposition,
                    ...(conflictingDisposition === 'watch_file_changes'
                        ? {
                            watchFileChanges: {
                                files: ['/tmp/conflicting-session.jsonl'],
                            },
                        }
                        : {}),
                },
                demand: demanded(),
                onFacts: (rejected) => rejectedFacts.push(...rejected.map((fact) => fact.kind)),
            })).resolves.toEqual({ state: 'disposition-mismatch' });
            await expect(reconciler.reconcileLink({
                resource: sharedResource,
                link: {
                    ...link(3),
                    changeObservation: 'observe_resource',
                },
                demand: demanded(),
                onFacts: () => {},
            })).resolves.toEqual({ state: 'observing' });

            emit?.(batch(
                ['native-1', 'accepted'],
                ['native-2', 'must-not-cross'],
            ));
            expect(acquireObserver).toHaveBeenCalledTimes(1);
            expect(watchFile).not.toHaveBeenCalled();
            expect(acceptedFacts).toEqual(['accepted']);
            expect(rejectedFacts).toEqual([]);

            await reconciler.dispose();
        }
    });

    it('routes a directly correlated refresh only through current qualified links', async () => {
        let requestTranscriptRefresh: ((linkKey: string) => void) | undefined;
        const refresh = vi.fn(async () => ({ requested: true, coalesced: false } as const));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                requestTranscriptRefresh = input.requestTranscriptRefresh;
                return { dispose: async () => {} };
            }),
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
        });
        const current = link(1, { linkKey: 'current-native' });

        await reconciler.reconcileLink({
            resource: resource(),
            link: current,
            demand: { ...demanded(), transcriptDemand: true },
            onFacts: () => {},
        });

        requestTranscriptRefresh?.('unknown-native');
        requestTranscriptRefresh?.('current-native');
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
        expect(refresh).toHaveBeenCalledWith({
            sessionId: 'session-1',
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: '7',
            },
        });

        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1, {
                linkGeneration: 'link-new',
                linkKey: 'replacement-native',
            }),
            demand: { ...demanded(), transcriptDemand: true },
            onFacts: () => {},
        });
        requestTranscriptRefresh?.('current-native');
        await Promise.resolve();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does not let a pooled observer grant facts or refresh to a later grouping link before descriptor hydration', async () => {
        let emit: ((batch: TestBatch) => void) | undefined;
        let requestRefresh: ((linkKey: string) => void) | undefined;
        let resolveDescriptors:
            ((result: TestReconcileResult) => void) | undefined;
        const descriptorResult = new Promise<TestReconcileResult>((resolve) => {
            resolveDescriptors = resolve;
        });
        let requestedDescriptorLinks:
            readonly ExternalSessionObservationLinkIdentity[] = [];
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => {
            if (input.purpose === 'observation_evidence') {
                return {
                    purpose: 'observation_evidence',
                    outcomes: [],
                };
            }
            requestedDescriptorLinks = input.links;
            return await descriptorResult;
        });
        const refresh = vi.fn(async () => {});
        const acceptedFacts = vi.fn();
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                emit = input.emit;
                requestRefresh = input.requestTranscriptRefresh;
                return { dispose: vi.fn() };
            }),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
        });
        const sharedResource = resource({
            resourceKey: 'descriptor-admission-fence',
        });

        await reconciler.reconcileLink({
            resource: sharedResource,
            link: {
                ...link(1),
                changeObservation: 'observe_resource',
            },
            demand: { ...demanded(), transcriptDemand: true },
            onFacts: () => {},
        });
        await expect(reconciler.reconcileLink({
            resource: sharedResource,
            link: {
                ...link(2),
                changeObservation: undefined,
            },
            demand: { ...demanded(), transcriptDemand: true },
            onFacts: acceptedFacts,
        })).resolves.toEqual({ state: 'reconcile-only' });
        await vi.waitFor(() => expect(requestedDescriptorLinks).toHaveLength(2));

        emit?.(batch(['native-2', 'before-hydration']));
        requestRefresh?.('native-2');
        await Promise.resolve();

        expect(acceptedFacts).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();

        resolveDescriptors?.({
            purpose: 'resource_descriptors',
            outcomes: requestedDescriptorLinks.map((current) => ({
                kind: 'described',
                descriptor: {
                    resourceKey: sharedResource.resourceKey,
                    linkKey: current.linkKey,
                    changeObservation: 'observe_resource',
                },
            })),
        });
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        await Promise.resolve();

        emit?.(batch(['native-2', 'after-hydration']));
        requestRefresh?.('native-2');
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        expect(acceptedFacts).toHaveBeenCalledWith([fact('after-hydration')]);

        await reconciler.dispose();
    });

    it('bounds reconnect refresh fan-out to the current resource admission map', async () => {
        let requestReconcile: (() => void) | undefined;
        const refresh = vi.fn(async () => ({ requested: false, reason: 'not-demanded' } as const));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                requestReconcile = input.requestReconcile;
                return { dispose: async () => {} };
            }),
            reconcileResource: vi.fn(async (): Promise<TestReconcileResult> => ({
                purpose: 'observation_evidence',
                outcomes: [],
            })),
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: ({ sessionId }) => sessionId === 'session-1',
        });
        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1),
            demand: { ...demanded(), transcriptDemand: true },
            onFacts: () => {},
        });
        await reconciler.reconcileLink({
            resource: resource(),
            link: link(2),
            demand: { ...demanded(), transcriptDemand: true },
            onFacts: () => {},
        });

        requestReconcile?.();

        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
        expect(refresh).toHaveBeenCalledWith({
            sessionId: 'session-1',
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: '7',
            },
        });
    });

    it('pools canonical file watchers under the resource and disposes them once on demand removal', async () => {
        const callbacks = new Map<string, (file: string) => void>();
        const disposals = new Map<string, ReturnType<typeof vi.fn>>();
        const watchFile = vi.fn((file: string, onChange: (file: string) => void) => {
            callbacks.set(file, onChange);
            const dispose = vi.fn();
            disposals.set(file, dispose);
            return dispose;
        });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            watchFile,
        } as Parameters<typeof createExternalSessionObservationReconciler>[0] & Readonly<{
            watchFile: typeof watchFile;
        }>);
        const watchedLink = (index: number) => ({
            ...link(index),
            changeObservation: 'watch_file_changes' as const,
            watchFileChanges: { files: ['/tmp/shared-session.jsonl'] },
        });

        await reconciler.reconcileLink({
            resource: resource(),
            link: watchedLink(1),
            demand: demanded(),
            onFacts: () => {},
        });
        await reconciler.reconcileLink({
            resource: resource(),
            link: watchedLink(2),
            demand: demanded(),
            onFacts: () => {},
        });

        expect(watchFile).toHaveBeenCalledTimes(1);
        expect(callbacks.has('/tmp/shared-session.jsonl')).toBe(true);

        await reconciler.removeLink(watchedLink(1));
        expect(disposals.get('/tmp/shared-session.jsonl')).not.toHaveBeenCalled();
        await reconciler.removeLink(watchedLink(2));
        expect(disposals.get('/tmp/shared-session.jsonl')).toHaveBeenCalledTimes(1);
        await reconciler.dispose();
        expect(disposals.get('/tmp/shared-session.jsonl')).toHaveBeenCalledTimes(1);
    });

    it('batches one topology doorbell for 100 links into one descriptor-purpose resource reconciliation', async () => {
        const topologyCallbacks = new Map<string, () => void>();
        const topologyDisposals = new Map<string, ReturnType<typeof vi.fn>>();
        const watchTopologyDirectory = vi.fn((directory: string, onChange: () => void) => {
            topologyCallbacks.set(directory, onChange);
            const dispose = vi.fn();
            topologyDisposals.set(directory, dispose);
            return dispose;
        });
        const reconcileResource = vi.fn(async (input: Readonly<{
            links: readonly { linkKey: string }[];
        }>): Promise<TestReconcileResult> => ({
            purpose: 'resource_descriptors',
            outcomes: input.links.map(({ linkKey }) => ({
                kind: 'described',
                descriptor: {
                    resourceKey: 'codex-home-generation-a',
                    linkKey,
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: {
                        files: [`/tmp/codex/sessions/${linkKey}.jsonl`],
                        topologyDirectories: [
                            '/tmp/codex/sessions',
                            '/tmp/codex/archived_sessions',
                        ],
                    },
                },
            })),
        }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            watchFile: vi.fn(() => vi.fn()),
            watchTopologyDirectory,
            reconcileResource,
        });
        const codexResource = resource({
            pluginId: 'happier.codex',
            agentLocalId: 'codex',
            resourceKey: 'codex-home-generation-a',
        });
        const watchedLinks = Array.from({ length: 100 }, (_, index) => ({
            ...link(index),
            changeObservation: 'watch_file_changes' as const,
            watchFileChanges: {
                files: [`/tmp/codex/sessions/root-${index}.jsonl`],
                topologyDirectories: [
                    '/tmp/codex/sessions',
                    '/tmp/codex/archived_sessions',
                ],
            },
        }));

        for (const watchedLink of watchedLinks) {
            await reconciler.reconcileLink({
                resource: codexResource,
                link: watchedLink,
                demand: demanded(),
                onFacts: () => {},
            });
        }

        expect(watchTopologyDirectory).toHaveBeenCalledTimes(2);
        expect([...topologyCallbacks.keys()].sort()).toEqual([
            '/tmp/codex/archived_sessions',
            '/tmp/codex/sessions',
        ]);

        topologyCallbacks.get('/tmp/codex/sessions')?.();

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledOnce());
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'resource_descriptors',
            links: expect.arrayContaining([
                expect.objectContaining({ linkKey: 'native-0' }),
                expect.objectContaining({ linkKey: 'native-99' }),
            ]),
        }));

        for (const watchedLink of watchedLinks) {
            await reconciler.removeLink(watchedLink);
        }
        for (const dispose of topologyDisposals.values()) {
            expect(dispose).toHaveBeenCalledTimes(1);
        }
        await reconciler.dispose();
        for (const dispose of topologyDisposals.values()) {
            expect(dispose).toHaveBeenCalledTimes(1);
        }
    });

    it('re-enters failed topology watch demand only when the current link is reconciled again', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout'],
        });
        type TopologyLifecycle = Readonly<{
            onReady(): void;
            onUnavailable(error: unknown): void;
        }>;
        const lifecycles: TopologyLifecycle[] = [];
        const disposers: Array<ReturnType<typeof vi.fn>> = [];
        const watchTopologyDirectories = vi.fn((
            _targets: readonly unknown[],
            lifecycle: TopologyLifecycle,
        ) => {
            lifecycles.push(lifecycle);
            const dispose = vi.fn();
            disposers.push(dispose);
            return dispose;
        });
        const reconcileResource = vi.fn(async (input: Readonly<{
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => ({
            purpose: 'resource_descriptors',
            outcomes: input.links.map((current) => ({
                kind: 'described',
                descriptor: {
                    resourceKey: 'codex-home-generation-a',
                    linkKey: current.linkKey,
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: current.watchFileChanges!,
                },
            })),
        }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            watchFile: vi.fn(() => vi.fn()),
            watchTopologyDirectories,
        });
        const watchedLink = {
            ...link(1),
            changeObservation: 'watch_file_changes' as const,
            watchFileChanges: {
                files: ['/tmp/codex/sessions/root-1.jsonl'],
                topologyDirectories: ['/tmp/codex/sessions'],
            },
        };

        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'codex-home-generation-a' }),
            link: watchedLink,
            demand: demanded(),
            onFacts: () => {},
        });
        expect(watchTopologyDirectories).toHaveBeenCalledOnce();
        lifecycles[0]?.onReady();

        const descriptorLimit = Object.assign(new Error('descriptor limit'), {
            code: 'EMFILE',
        });
        lifecycles[0]?.onUnavailable(descriptorLimit);
        lifecycles[0]?.onUnavailable(descriptorLimit);
        expect(disposers[0]).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        expect(reconcileResource).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(120_000);
        expect(watchTopologyDirectories).toHaveBeenCalledOnce();
        expect(reconcileResource).not.toHaveBeenCalled();

        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'codex-home-generation-a' }),
            link: watchedLink,
            demand: demanded(),
            onFacts: () => {},
        });
        expect(watchTopologyDirectories).toHaveBeenCalledTimes(2);
        lifecycles[1]?.onReady();
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(reconcileResource).toHaveBeenCalledOnce();
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'resource_descriptors',
            links: [expect.objectContaining({ sessionId: 'session-1' })],
        }));
        expect(vi.getTimerCount()).toBe(0);

        await reconciler.dispose();
        expect(disposers[1]).toHaveBeenCalledOnce();
    });

    it.each(['disposal', 'generation retirement'] as const)(
        'does not recreate a failed topology watcher after %s',
        async (stopKind) => {
            vi.useFakeTimers({
                toFake: ['setTimeout', 'clearTimeout'],
            });
            type TopologyLifecycle = Readonly<{
                onReady(): void;
                onUnavailable(error: unknown): void;
            }>;
            const lifecycles: TopologyLifecycle[] = [];
            const disposeTopologyWatch = vi.fn();
            const watchTopologyDirectories = vi.fn((
                _targets: readonly unknown[],
                lifecycle: TopologyLifecycle,
            ) => {
                lifecycles.push(lifecycle);
                return disposeTopologyWatch;
            });
            const retirement = new AbortController();
            const reconciler = createExternalSessionObservationReconciler({
                acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
                reconcileResource: vi.fn(),
                watchFile: vi.fn(() => vi.fn()),
                watchTopologyDirectories,
            });
            const watchedLink = {
                ...link(1),
                changeObservation: 'watch_file_changes' as const,
                watchFileChanges: {
                    files: ['/tmp/codex/sessions/root-1.jsonl'],
                    topologyDirectories: ['/tmp/codex/sessions'],
                },
            };

            await reconciler.reconcileLink({
                resource: resource({
                    resourceKey: 'codex-home-generation-a',
                    retirementSignal: retirement.signal,
                }),
                link: watchedLink,
                demand: demanded(),
                onFacts: () => {},
            });
            lifecycles[0]?.onReady();
            lifecycles[0]?.onUnavailable(
                Object.assign(new Error('descriptor limit'), {
                    code: 'EMFILE',
                }),
            );
            expect(vi.getTimerCount()).toBe(0);

            if (stopKind === 'disposal') {
                await reconciler.dispose();
            } else {
                retirement.abort();
                await Promise.resolve();
            }
            expect(disposeTopologyWatch).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);

            await vi.advanceTimersByTimeAsync(120_000);
            expect(watchTopologyDirectories).toHaveBeenCalledOnce();
            await reconciler.dispose();
        },
    );

    it('deduplicates a shared native link for topology description and fans described/unavailable outcomes to every Happier link', async () => {
        let onTopologyChange: (() => void) | undefined;
        const fileDisposals = new Map<string, ReturnType<typeof vi.fn>>();
        const refresh = vi.fn(async (
            _input: Readonly<{ sessionId: string }>,
        ) => ({ requested: true } as const));
        let returnUnavailable = false;
        const reconcileResource = vi.fn(async (input: Readonly<{
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => {
            const requestedLinkKeys = input.links.map(({ linkKey }) => linkKey);
            if (new Set(requestedLinkKeys).size !== requestedLinkKeys.length) {
                throw new TypeError('duplicate requested link key');
            }
            return {
                purpose: 'resource_descriptors',
                outcomes: returnUnavailable
                    ? [{
                        kind: 'unavailable',
                        linkKey: 'shared-native-session',
                    }]
                    : [{
                        kind: 'described',
                        descriptor: {
                            resourceKey: 'codex-home-generation-a',
                            linkKey: 'shared-native-session',
                            changeObservation: 'watch_file_changes',
                            watchFileChanges: {
                                files: [
                                    '/tmp/codex/sessions/shared-root.jsonl',
                                    '/tmp/codex/sessions/shared-child.jsonl',
                                ],
                                topologyDirectories: ['/tmp/codex/sessions'],
                            },
                        },
                    }],
            };
        });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn((file) => {
                const dispose = vi.fn();
                fileDisposals.set(file, dispose);
                return dispose;
            }),
            watchTopologyDirectory: vi.fn((_directory, onChange) => {
                onTopologyChange = onChange;
                return vi.fn();
            }),
        });
        const sharedLinks = [1, 2].map((index) => ({
            ...link(index, { linkKey: 'shared-native-session' }),
            changeObservation: 'watch_file_changes' as const,
            watchFileChanges: {
                files: [`/tmp/codex/sessions/prior-${index}.jsonl`],
                topologyDirectories: ['/tmp/codex/sessions'],
            },
        }));
        const received: TestFact[][] = [[], []];

        for (const [index, sharedLink] of sharedLinks.entries()) {
            await reconciler.reconcileLink({
                resource: resource({ resourceKey: 'codex-home-generation-a' }),
                link: sharedLink,
                demand: { ...demanded(), transcriptDemand: true },
                onFacts: (facts) => received[index]!.push(...facts),
            });
        }

        onTopologyChange?.();

        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'resource_descriptors',
            links: [expect.objectContaining({
                linkKey: 'shared-native-session',
            })],
        }));
        expect(refresh.mock.calls.map(([input]) => input.sessionId).sort())
            .toEqual(['session-1', 'session-2']);
        expect(received).toEqual([[], []]);

        returnUnavailable = true;
        onTopologyChange?.();

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledTimes(2));
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(received).toEqual([[], []]);
        expect(fileDisposals.get('/tmp/codex/sessions/shared-root.jsonl'))
            .not.toHaveBeenCalled();
        expect(fileDisposals.get('/tmp/codex/sessions/shared-child.jsonl'))
            .not.toHaveBeenCalled();

        await reconciler.removeLink(sharedLinks[0]!);
        expect(fileDisposals.get('/tmp/codex/sessions/shared-root.jsonl'))
            .not.toHaveBeenCalled();
        expect(fileDisposals.get('/tmp/codex/sessions/shared-child.jsonl'))
            .not.toHaveBeenCalled();
        await reconciler.removeLink(sharedLinks[1]!);
        expect(fileDisposals.get('/tmp/codex/sessions/shared-root.jsonl'))
            .toHaveBeenCalledOnce();
        expect(fileDisposals.get('/tmp/codex/sessions/shared-child.jsonl'))
            .toHaveBeenCalledOnce();
        await reconciler.dispose();
    });

    it('coalesces topology events into whole-resource re-description without refreshing unchanged links', async () => {
        let onTopologyChange: (() => void) | undefined;
        let finishDescription: (() => void) | undefined;
        const descriptionGate = new Promise<void>((resolve) => {
            finishDescription = resolve;
        });
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => {
            await descriptionGate;
            return {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: 'codex-home-generation-a',
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            };
        });
        const refresh = vi.fn(async () => ({ requested: true, coalesced: false } as const));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn(() => vi.fn()),
            watchTopologyDirectory: vi.fn((_directory, onChange) => {
                onTopologyChange = onChange;
                return vi.fn();
            }),
        });
        for (const index of [1, 2]) {
            await reconciler.reconcileLink({
                resource: resource({ resourceKey: 'codex-home-generation-a' }),
                link: {
                    ...link(index),
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: {
                        files: [`/tmp/codex/sessions/root-${index}.jsonl`],
                        topologyDirectories: ['/tmp/codex/sessions'],
                    },
                },
                demand: { ...demanded(), transcriptDemand: true },
                onFacts: () => {},
            });
        }

        onTopologyChange?.();
        onTopologyChange?.();
        onTopologyChange?.();
        finishDescription?.();

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledOnce());
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'resource_descriptors',
        }));
        expect(refresh).not.toHaveBeenCalled();
        await reconciler.dispose();
    });

    it('queues one bounded topology re-description when an event arrives during an in-flight scan', async () => {
        let onTopologyChange: (() => void) | undefined;
        let releaseFirstPass: (() => void) | undefined;
        const firstPass = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        let childDiscovered = false;
        let reconciliationCalls = 0;
        const refresh = vi.fn(async () => ({ requested: true, coalesced: false } as const));
        const reconcileResource = vi.fn(async (input: Readonly<{
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => {
            reconciliationCalls += 1;
            if (reconciliationCalls === 1) {
                await firstPass;
            }
            return {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: 'codex-home-generation-a',
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.sessionId === 'session-1'
                            && childDiscovered
                            ? {
                                ...current.watchFileChanges!,
                                files: [
                                    '/tmp/codex/sessions/root-1.jsonl',
                                    '/tmp/codex/sessions/child-1.jsonl',
                                ],
                            }
                            : current.watchFileChanges!,
                    },
                })),
            };
        });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn(() => vi.fn()),
            watchTopologyDirectory: vi.fn((_directory, onChange) => {
                onTopologyChange = onChange;
                return vi.fn();
            }),
        });
        for (const index of [1, 2]) {
            await reconciler.reconcileLink({
                resource: resource({ resourceKey: 'codex-home-generation-a' }),
                link: {
                    ...link(index),
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: {
                        files: [`/tmp/codex/sessions/root-${index}.jsonl`],
                        topologyDirectories: ['/tmp/codex/sessions'],
                    },
                },
                demand: { ...demanded(), transcriptDemand: true },
                onFacts: () => {},
            });
        }

        onTopologyChange?.();
        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledOnce());
        childDiscovered = true;
        onTopologyChange?.();
        onTopologyChange?.();
        releaseFirstPass?.();

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        await reconciler.dispose();
    });

    it('preserves one queued topology pass when the in-flight descriptor batch rejects', async () => {
        let onTopologyChange: (() => void) | undefined;
        let releaseFirstPass: (() => void) | undefined;
        const firstPass = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        let calls = 0;
        const reconcileResource = vi.fn(async (input: Readonly<{
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => {
            calls += 1;
            if (calls === 1) {
                await firstPass;
                throw new Error('descriptor inventory rejected');
            }
            return {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: 'codex-home-generation-a',
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            };
        });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            watchFile: vi.fn(() => vi.fn()),
            watchTopologyDirectory: vi.fn((_directory, onChange) => {
                onTopologyChange = onChange;
                return vi.fn();
            }),
        });
        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'codex-home-generation-a' }),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: {
                    files: ['/tmp/codex/sessions/root-1.jsonl'],
                    topologyDirectories: ['/tmp/codex/sessions'],
                },
            },
            demand: demanded(),
            onFacts: () => {},
        });

        onTopologyChange?.();
        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledOnce());
        onTopologyChange?.();
        releaseFirstPass?.();

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledTimes(2));
        await reconciler.dispose();
    });

    it('transfers one queued topology pass to the current resource after rotation', async () => {
        const topologyCallbacks: Array<() => void> = [];
        let releaseFirstPass: (() => void) | undefined;
        const firstPass = new Promise<void>((resolve) => {
            releaseFirstPass = resolve;
        });
        let calls = 0;
        const reconcileResource = vi.fn(async (input: Readonly<{
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => {
            calls += 1;
            if (calls === 1) {
                await firstPass;
            }
            return {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: 'codex-home-generation-b',
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            };
        });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            watchFile: vi.fn(() => vi.fn()),
            watchTopologyDirectory: vi.fn((_directory, onChange) => {
                topologyCallbacks.push(onChange);
                return vi.fn();
            }),
        });
        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'codex-home-generation-a' }),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: {
                    files: ['/tmp/codex/sessions/root-1.jsonl'],
                    topologyDirectories: ['/tmp/codex/sessions'],
                },
            },
            demand: demanded(),
            onFacts: () => {},
        });

        topologyCallbacks[0]?.();
        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledOnce());
        topologyCallbacks[0]?.();
        releaseFirstPass?.();

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledTimes(2));
        expect(reconcileResource.mock.calls[1]?.[0].resource.resourceKey)
            .toBe('codex-home-generation-b');
        await reconciler.dispose();
    });

    it('refreshes only a demanded link whose exact file set changes after a topology event', async () => {
        let onTopologyChange: (() => void) | undefined;
        const fileCallbacks = new Map<string, (file: string) => void>();
        const fileDisposals = new Map<string, ReturnType<typeof vi.fn>>();
        const refresh = vi.fn(async () => ({ requested: true, coalesced: false } as const));
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => input.purpose === 'observation_evidence'
            ? {
                purpose: 'observation_evidence',
                outcomes: [],
            }
            : {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => (
                current.sessionId === 'session-1'
                    ? {
                        kind: 'described' as const,
                        descriptor: {
                            resourceKey: 'codex-home-generation-a',
                            linkKey: current.linkKey,
                            changeObservation: 'watch_file_changes' as const,
                            watchFileChanges: {
                                ...current.watchFileChanges!,
                                files: [
                                    '/tmp/codex/sessions/root-1.jsonl',
                                    '/tmp/codex/sessions/child-1.jsonl',
                                ],
                            },
                        },
                    }
                    : {
                        kind: 'unavailable' as const,
                        linkKey: current.linkKey,
                    }
                )),
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn((file, onChange) => {
                fileCallbacks.set(file, onChange);
                const dispose = vi.fn();
                fileDisposals.set(file, dispose);
                return dispose;
            }),
            watchTopologyDirectory: vi.fn((_directory, onChange) => {
                onTopologyChange = onChange;
                return vi.fn();
            }),
        });
        for (const index of [1, 2, 3]) {
            await reconciler.reconcileLink({
                resource: resource({ resourceKey: 'codex-home-generation-a' }),
                link: {
                    ...link(index),
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: {
                        files: [`/tmp/codex/sessions/root-${index}.jsonl`],
                        topologyDirectories: ['/tmp/codex/sessions'],
                    },
                },
                demand: index === 3
                    ? {
                        passiveEvent: false,
                        persistedPolicy: false,
                        fallbackDemand: true,
                        transcriptDemand: false,
                    }
                    : {
                        ...demanded(),
                        transcriptDemand: index === 1,
                    },
                onFacts: () => {},
            });
        }

        onTopologyChange?.();

        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'resource_descriptors',
            links: [
                expect.objectContaining({ sessionId: 'session-1' }),
                expect.objectContaining({ sessionId: 'session-2' }),
            ],
        }));
        expect(refresh).toHaveBeenCalledWith({
            sessionId: 'session-1',
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: '7',
            },
        });
        expect(fileCallbacks.has('/tmp/codex/sessions/child-1.jsonl')).toBe(true);
        expect(fileDisposals.get('/tmp/codex/sessions/root-2.jsonl'))
            .not.toHaveBeenCalled();

        fileCallbacks.get('/tmp/codex/sessions/root-2.jsonl')?.(
            '/tmp/codex/sessions/root-2.jsonl',
        );
        await vi.waitFor(() => {
            expect(reconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            )).toHaveLength(2);
            expect(reconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'observation_evidence',
            )).toHaveLength(1);
        });
        expect(reconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )[1]?.[0]).toEqual(
            expect.objectContaining({
                links: [expect.objectContaining({ sessionId: 'session-2' })],
            }),
        );
        await reconciler.dispose();
        for (const dispose of fileDisposals.values()) {
            expect(dispose).toHaveBeenCalledTimes(1);
        }
    });

    it('keeps an exact-file append on the matching-link path instead of topology-wide work', async () => {
        const fileCallbacks = new Map<string, (file: string) => void>();
        let onTopologyChange: ((changedPath?: string) => void) | undefined;
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => input.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: 'codex-home-generation-a',
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            }
            : {
                purpose: 'observation_evidence',
                outcomes: [],
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: vi.fn(async () => ({ requested: true, coalesced: false } as const)),
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn((file, onChange) => {
                fileCallbacks.set(file, onChange);
                return vi.fn();
            }),
            watchTopologyDirectory: vi.fn((_directory, onChange) => {
                onTopologyChange = onChange;
                return vi.fn();
            }),
        });
        for (const index of [1, 2]) {
            await reconciler.reconcileLink({
                resource: resource({ resourceKey: 'codex-home-generation-a' }),
                link: {
                    ...link(index),
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: {
                        files: [`/tmp/codex/sessions/root-${index}.jsonl`],
                        topologyDirectories: ['/tmp/codex/sessions'],
                    },
                },
                demand: { ...demanded(), transcriptDemand: true },
                onFacts: () => {},
            });
        }

        fileCallbacks.get('/tmp/codex/sessions/root-1.jsonl')?.(
            '/tmp/codex/sessions/root-1.jsonl',
        );
        onTopologyChange?.('/tmp/codex/sessions/root-1.jsonl');

        await vi.waitFor(() => expect(
            reconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            ),
        ).toHaveLength(1));
        expect(reconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )[0]?.[0]).toEqual(expect.objectContaining({
            links: [expect.objectContaining({ sessionId: 'session-1' })],
        }));
        await reconciler.dispose();
    });

    it('keeps transcript-only exact-file work out of observation evidence reconciliation', async () => {
        const fileCallbacks = new Map<string, (file: string) => void>();
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => input.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: 'codex-home-generation-a',
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            }
            : {
                purpose: 'observation_evidence',
                outcomes: input.links.map((current) => ({
                    linkKey: current.linkKey,
                    facts: [],
                })),
            });
        const refresh = vi.fn(async () => ({ requested: true, coalesced: false } as const));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn((file, onChange) => {
                fileCallbacks.set(file, onChange);
                return vi.fn();
            }),
        });
        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'codex-home-generation-a' }),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: {
                    files: ['/tmp/codex/sessions/root-1.jsonl'],
                },
            },
            demand: {
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: false,
                transcriptDemand: true,
            },
            onFacts: () => {},
        });

        fileCallbacks.get('/tmp/codex/sessions/root-1.jsonl')?.(
            '/tmp/codex/sessions/root-1.jsonl',
        );

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'resource_descriptors',
        }));
        await reconciler.dispose();
    });

    it('coalesces file callbacks into re-description plus one resource-wide reconciliation', async () => {
        const callbacks = new Map<string, (file: string) => void>();
        const disposals = new Map<string, ReturnType<typeof vi.fn>>();
        const watchFile = vi.fn((file: string, onChange: (file: string) => void) => {
            callbacks.set(file, onChange);
            const dispose = vi.fn();
            disposals.set(file, dispose);
            return dispose;
        });
        let finishDescription: (() => void) | undefined;
        const descriptionGate = new Promise<void>((resolve) => {
            finishDescription = resolve;
        });
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => {
            await descriptionGate;
            if (input.purpose === 'resource_descriptors') {
                return {
                    purpose: 'resource_descriptors',
                    outcomes: input.links.map((current) => ({
                        kind: 'described',
                        descriptor: {
                            resourceKey: input.resource.resourceKey,
                            linkKey: current.linkKey,
                            changeObservation: 'watch_file_changes',
                            watchFileChanges: {
                                files: ['/tmp/replaced-session.jsonl'],
                            },
                        },
                    })),
                };
            }
            return result(['native-1', 'after-file-change']);
        });
        const received: TestFact[] = [];
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            watchFile,
        } as Parameters<typeof createExternalSessionObservationReconciler>[0] & Readonly<{
            watchFile: typeof watchFile;
        }>);
        const watchedLink = {
            ...link(1),
            changeObservation: 'watch_file_changes' as const,
            watchFileChanges: { files: ['/tmp/session.jsonl'] },
        };
        await reconciler.reconcileLink({
            resource: resource(),
            link: watchedLink,
            demand: demanded(),
            onFacts: (values) => received.push(...values),
        });

        callbacks.get('/tmp/session.jsonl')?.('/tmp/session.jsonl');
        callbacks.get('/tmp/session.jsonl')?.('/tmp/session.jsonl');
        finishDescription?.();

        await vi.waitFor(() => {
            expect(reconcileResource).toHaveBeenCalledTimes(2);
            expect(received).toEqual([fact('after-file-change')]);
        });
        expect(watchFile).toHaveBeenCalledTimes(2);
        expect(disposals.get('/tmp/session.jsonl')).toHaveBeenCalledTimes(1);
    });

    it('re-describes file changes before refreshing only a still-declared matching path', async () => {
        const callbacks = new Map<string, (file: string) => void>();
        const refresh = vi.fn(async () => ({ requested: true, coalesced: false } as const));
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => input.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: input.resource.resourceKey,
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.sessionId === 'session-1'
                            ? current.watchFileChanges!
                            : { files: ['/tmp/replaced.jsonl'] },
                    },
                })),
            }
            : {
                purpose: 'observation_evidence',
                outcomes: [],
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn((file, callback) => {
                callbacks.set(file, callback);
                return vi.fn();
            }),
        });
        for (const index of [1, 2]) {
            await reconciler.reconcileLink({
                resource: resource(),
                link: {
                    ...link(index),
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: { files: ['/tmp/session.jsonl'] },
                },
                demand: demanded(),
                onFacts: () => {},
            });
        }

        callbacks.get('/tmp/session.jsonl')?.('/tmp/session.jsonl');

        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
        expect(refresh).toHaveBeenCalledWith({
            sessionId: 'session-1',
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: '7',
            },
        });
    });

    it('refreshes and reconciles a current watched link when deletion prevents re-description', async () => {
        let onChange: ((file: string) => void) | undefined;
        const refresh = vi.fn(async () => ({ requested: true, coalesced: false } as const));
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => input.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'unavailable',
                    linkKey: current.linkKey,
                })),
            }
            : {
                purpose: 'observation_evidence',
                outcomes: [],
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn((_file, callback) => {
                onChange = callback;
                return vi.fn();
            }),
        });
        const watchedLink = {
            ...link(1),
            changeObservation: 'watch_file_changes' as const,
            watchFileChanges: { files: ['/tmp/deleted-session.jsonl'] },
        };
        await reconciler.reconcileLink({
            resource: resource(),
            link: watchedLink,
            demand: {
                ...demanded(),
                transcriptDemand: true,
            },
            onFacts: () => {},
        });

        onChange?.('/tmp/deleted-session.jsonl');

        await vi.waitFor(() => {
            expect(refresh).toHaveBeenCalledOnce();
            expect(reconcileResource).toHaveBeenCalledTimes(2);
        });
        expect(refresh).toHaveBeenCalledWith({
            sessionId: 'session-1',
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: '7',
            },
        });
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'observation_evidence',
            links: [expect.objectContaining({
                linkKey: 'native-1',
            })],
        }));

        await reconciler.dispose();
    });

    it('refreshes a current watched link after file replacement rotates its resource identity', async () => {
        let onChange: ((file: string) => void) | undefined;
        const refresh = vi.fn(async () => ({ requested: true, coalesced: false } as const));
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => input.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: 'replacement-physical-resource',
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            }
            : {
                purpose: 'observation_evidence',
                outcomes: [],
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            watchFile: vi.fn((_file, callback) => {
                onChange = callback;
                return vi.fn();
            }),
        });
        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'original-physical-resource' }),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: { files: ['/tmp/replaced-session.jsonl'] },
            },
            demand: {
                ...demanded(),
                transcriptDemand: true,
            },
            onFacts: () => {},
        });

        onChange?.('/tmp/replaced-session.jsonl');

        await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        expect(refresh).toHaveBeenCalledWith({
            sessionId: 'session-1',
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: '7',
            },
        });

        await reconciler.dispose();
    });

    it('owns abort-triggered resource retirement and retries the exact same observer cleanup', async () => {
        // Generation retirement is owner-driven cleanup, not a caller promise. An
        // unhandled rejection here reaches the daemon's process handler, which turns
        // it into `requestShutdown('exception')` — one plugin observer whose disposal
        // failed must not take the daemon down. The failure is still not discarded:
        // a rejected deactivation keeps the resource under this reconciler, so the
        // disposal owner retries the exact same cleanup and surfaces it there.
        const retirement = new AbortController();
        const dispose = vi.fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('observer cleanup failed'))
            .mockResolvedValue(undefined);
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose })),
            reconcileResource: vi.fn(async (): Promise<TestReconcileResult> => ({
                purpose: 'observation_evidence',
                outcomes: [],
            })),
        });

        await reconciler.reconcileLink({
            resource: resource({ retirementSignal: retirement.signal }),
            link: {
                ...link(1),
                changeObservation: 'observe_resource',
            },
            demand: demanded(),
            onFacts: () => {},
        });

        const unhandled: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        try {
            retirement.abort();
            // Let Node run its unhandled-rejection detection for this turn.
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
            expect(dispose).toHaveBeenCalledTimes(1);
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }

        await reconciler.dispose();
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('drops late file callbacks and retires the watcher exactly once with its Agent generation', async () => {
        const retirement = new AbortController();
        let onChange: ((file: string) => void) | undefined;
        const disposeWatch = vi.fn();
        const reconcileResource = vi.fn(async (): Promise<TestReconcileResult> => result(
            ['native-1', 'must-not-route'],
        ));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
            watchFile: vi.fn((_file, callback) => {
                onChange = callback;
                return disposeWatch;
            }),
        });

        await reconciler.reconcileLink({
            resource: resource({ retirementSignal: retirement.signal }),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: { files: ['/tmp/session.jsonl'] },
            },
            demand: demanded(),
            onFacts: () => {},
        });
        retirement.abort();
        retirement.abort();
        onChange?.('/tmp/session.jsonl');
        await Promise.resolve();

        expect(disposeWatch).toHaveBeenCalledTimes(1);
        expect(reconcileResource).not.toHaveBeenCalled();
    });

    it('rebinds transcript demand to the replacement generation exact watcher and refreshes only there', async () => {
        const retiredGeneration = new AbortController();
        const replacementGeneration = new AbortController();
        const callbacksByFile = new Map<string, (file: string) => void>();
        const disposersByFile = new Map<string, ReturnType<typeof vi.fn>>();
        const refresh = vi.fn(async () => ({ requested: true } as const));
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => input.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'described',
                    descriptor: {
                        resourceKey: input.resource.resourceKey,
                        linkKey: current.linkKey,
                        changeObservation: 'watch_file_changes',
                        watchFileChanges: current.watchFileChanges!,
                    },
                })),
            }
            : {
                purpose: 'observation_evidence',
                outcomes: [],
            });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: () => true,
            reconcileResource,
            watchFile: vi.fn((file, callback) => {
                callbacksByFile.set(file, callback);
                const dispose = vi.fn();
                disposersByFile.set(file, dispose);
                return dispose;
            }),
        });
        const retiredFile = '/tmp/retired-generation.jsonl';
        const replacementFile = '/tmp/replacement-generation.jsonl';
        const transcriptDemand = {
            ...demanded(),
            transcriptDemand: true,
        };

        await reconciler.reconcileLink({
            resource: resource({
                pluginGeneration: '7',
                retirementSignal: retiredGeneration.signal,
            }),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: { files: [retiredFile] },
            },
            demand: transcriptDemand,
            onFacts: () => {},
        });

        retiredGeneration.abort();
        await vi.waitFor(() => {
            expect(disposersByFile.get(retiredFile)).toHaveBeenCalledTimes(1);
        });
        await reconciler.reconcileLink({
            resource: resource({
                pluginGeneration: '8',
                resourceKey: 'replacement-resource',
                retirementSignal: replacementGeneration.signal,
            }),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: { files: [replacementFile] },
            },
            demand: transcriptDemand,
            onFacts: () => {},
        });

        callbacksByFile.get(retiredFile)?.(retiredFile);
        callbacksByFile.get(replacementFile)?.(replacementFile);
        await vi.waitFor(() => {
            expect(reconcileResource.mock.calls.filter(
                ([input]) => input.purpose === 'resource_descriptors',
            )).toHaveLength(1);
            expect(refresh).toHaveBeenCalledTimes(1);
        });
        expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
            purpose: 'resource_descriptors',
            resource: expect.objectContaining({
                pluginGeneration: '8',
                resourceKey: 'replacement-resource',
            }),
            links: [expect.objectContaining({
                watchFileChanges: { files: [replacementFile] },
            })],
        }));
        expect(refresh).toHaveBeenCalledWith({
            sessionId: 'session-1',
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: '8',
            },
        });
        expect(disposersByFile.get(retiredFile)).toHaveBeenCalledTimes(1);
        expect(disposersByFile.get(replacementFile)).not.toHaveBeenCalled();

        await reconciler.dispose();
        expect(disposersByFile.get(retiredFile)).toHaveBeenCalledTimes(1);
        expect(disposersByFile.get(replacementFile)).toHaveBeenCalledTimes(1);
    });

    it('drops late topology callbacks and retires each topology watcher exactly once', async () => {
        const retirement = new AbortController();
        let onTopologyChange: (() => void) | undefined;
        const disposeTopologyWatch = vi.fn();
        const reconcileResource = vi.fn();
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            watchFile: vi.fn(() => vi.fn()),
            watchTopologyDirectory: vi.fn((_directory, callback) => {
                onTopologyChange = callback;
                return disposeTopologyWatch;
            }),
            reconcileResource,
        });

        await reconciler.reconcileLink({
            resource: resource({
                resourceKey: 'codex-home-generation-a',
                retirementSignal: retirement.signal,
            }),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: {
                    files: ['/tmp/codex/sessions/root.jsonl'],
                    topologyDirectories: ['/tmp/codex/sessions'],
                },
            },
            demand: demanded(),
            onFacts: () => {},
        });
        retirement.abort();
        retirement.abort();
        onTopologyChange?.();
        await Promise.resolve();

        expect(disposeTopologyWatch).toHaveBeenCalledTimes(1);
        expect(reconcileResource).not.toHaveBeenCalled();
        await reconciler.dispose();
        expect(disposeTopologyWatch).toHaveBeenCalledTimes(1);
    });

    it('aborts and retires an active observer generation before rejecting its late callbacks and admitting its replacement', async () => {
        const retiredGeneration = new AbortController();
        const replacementGeneration = new AbortController();
        let retiredSignal: AbortSignal | undefined;
        let retiredEmit: ((batch: TestBatch) => void) | undefined;
        let retiredRequestReconcile: (() => void) | undefined;
        let retiredRequestTranscriptRefresh: ((linkKey: string) => void) | undefined;
        let replacementEmit: ((batch: TestBatch) => void) | undefined;
        const retiredDispose = vi.fn(async () => {});
        const replacementDispose = vi.fn(async () => {});
        const reconcileResource = vi.fn(
            async (): Promise<TestReconcileResult> => result(
                ['native-1', 'must-not-reconcile'],
            ),
        );
        const requestTranscriptRefresh = vi.fn(async () => {});
        const received: TestFact[] = [];
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                if (input.resource.pluginGeneration === '7') {
                    retiredSignal = input.signal;
                    retiredEmit = input.emit;
                    retiredRequestReconcile = input.requestReconcile;
                    retiredRequestTranscriptRefresh =
                        input.requestTranscriptRefresh;
                    return { dispose: retiredDispose };
                }
                replacementEmit = input.emit;
                return { dispose: replacementDispose };
            }),
            reconcileResource,
            requestTranscriptRefresh,
            isTranscriptRefreshDemanded: () => true,
        });

        await reconciler.reconcileLink({
            resource: resource({ retirementSignal: retiredGeneration.signal }),
            link: link(1),
            demand: demanded({ fallbackDemand: true }),
            onFacts: (receivedFacts) => received.push(...receivedFacts),
        });

        retiredGeneration.abort();
        expect(retiredSignal?.aborted).toBe(true);
        await vi.waitFor(() => expect(retiredDispose).toHaveBeenCalledTimes(1));

        retiredEmit?.(batch(['native-1', 'must-not-emit']));
        retiredRequestReconcile?.();
        retiredRequestTranscriptRefresh?.('native-1');
        await Promise.resolve();
        expect(received).toEqual([]);
        expect(reconcileResource).not.toHaveBeenCalled();
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();

        await expect(reconciler.reconcileLink({
            resource: resource({
                pluginGeneration: '8',
                retirementSignal: replacementGeneration.signal,
            }),
            link: link(1, { linkGeneration: 'link-2' }),
            demand: demanded(),
            onFacts: (receivedFacts) => received.push(...receivedFacts),
        })).resolves.toEqual({ state: 'observing' });
        replacementEmit?.(batch(['native-1', 'replacement']));

        expect(received).toEqual([fact('replacement')]);
        await reconciler.dispose();
        expect(retiredDispose).toHaveBeenCalledTimes(1);
        expect(replacementDispose).toHaveBeenCalledTimes(1);
    });

    it('does not admit a resource whose generation already retired', async () => {
        const retirement = new AbortController();
        retirement.abort();
        const acquireObserver = vi.fn(async () => ({
            dispose: async () => {},
        }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
        });

        await expect(reconciler.reconcileLink({
            resource: resource({ retirementSignal: retirement.signal }),
            link: link(1),
            demand: demanded(),
            onFacts: () => {},
        })).resolves.toEqual({ state: 'superseded' });

        expect(acquireObserver).not.toHaveBeenCalled();
        await reconciler.dispose();
    });

    it('aborts in-flight reconciliation and rejects its late facts when the resource generation retires', async () => {
        const retirement = new AbortController();
        let observedSignal: AbortSignal | undefined;
        let resolveReconciliation: (
            result: TestReconcileResult,
        ) => void = () => {};
        const reconciliation = new Promise<TestReconcileResult>((resolve) => {
            resolveReconciliation = resolve;
        });
        const received: TestFact[] = [];
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource: vi.fn(async (input) => {
                observedSignal = input.signal;
                return await reconciliation;
            }),
        });
        const observedResource = resource({
            retirementSignal: retirement.signal,
        });

        await reconciler.reconcileLink({
            resource: observedResource,
            link: link(1),
            demand: demanded({
                passiveEvent: false,
                fallbackDemand: true,
            }),
            onFacts: (receivedFacts) => received.push(...receivedFacts),
        });
        const reconciling = reconciler.reconcileResource(observedResource);
        await vi.waitFor(() => expect(observedSignal).toBeDefined());

        retirement.abort();
        expect(observedSignal?.aborted).toBe(true);
        resolveReconciliation(result(['native-1', 'must-not-route']));

        await expect(reconciling).resolves.toEqual({
            state: 'stale-resource',
        });
        expect(received).toEqual([]);
        await reconciler.dispose();
    });

    it('does not start a file watcher without passive or persisted observation demand', async () => {
        const watchFile = vi.fn(() => vi.fn());
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            watchFile,
        });

        await reconciler.reconcileLink({
            resource: resource(),
            link: {
                ...link(1),
                changeObservation: 'watch_file_changes',
                watchFileChanges: { files: ['/tmp/session.jsonl'] },
            },
            demand: demanded({
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: true,
            }),
            onFacts: () => {},
        });

        expect(watchFile).not.toHaveBeenCalled();
    });

    it('runs only evidence reconciliation for an initial status-only grouping link', async () => {
        const acquireObserver = vi.fn(async () => ({ dispose: vi.fn() }));
        const watchFile = vi.fn(() => vi.fn());
        const watchTopologyDirectory = vi.fn(() => vi.fn());
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => (
            input.purpose === 'resource_descriptors'
                ? {
                    purpose: input.purpose,
                    outcomes: input.links.map((current) => ({
                        kind: 'described',
                        descriptor: {
                            resourceKey: input.resource.resourceKey,
                            linkKey: current.linkKey,
                            changeObservation: 'reconcile_only',
                        },
                    })),
                }
                : result(['native-1', 'must-not-route'])
        ));
        const onFacts = vi.fn();
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            watchFile,
            watchTopologyDirectory,
            reconcileResource,
        });
        const groupingResource = resource({
            resourceKey: 'grouping-only-status',
        });

        await expect(reconciler.reconcileLink({
            resource: groupingResource,
            link: {
                ...link(1),
                changeObservation: undefined,
            },
            demand: {
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: true,
                transcriptDemand: false,
            },
            onFacts,
        })).resolves.toEqual({ state: 'reconcile-only' });
        await reconciler.reconcileResource(groupingResource);

        expect(reconcileResource).toHaveBeenCalledTimes(1);
        expect(reconcileResource.mock.calls.map(
            ([request]) => request.purpose,
        )).toEqual(['observation_evidence']);
        expect(reconcileResource.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                links: [expect.objectContaining({ linkKey: 'native-1' })],
            }),
        );
        expect(acquireObserver).not.toHaveBeenCalled();
        expect(watchFile).not.toHaveBeenCalled();
        expect(watchTopologyDirectory).not.toHaveBeenCalled();
        expect(onFacts).toHaveBeenCalledWith([fact('must-not-route')]);
        await reconciler.dispose();
    });

    it('coalesces sequential later grouping links into one complete descriptor pass', async () => {
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => (
            input.purpose === 'resource_descriptors'
                ? {
                    purpose: 'resource_descriptors',
                    outcomes: input.links.map((current) => ({
                        kind: 'described',
                        descriptor: {
                            resourceKey: input.resource.resourceKey,
                            linkKey: current.linkKey,
                            changeObservation: 'reconcile_only',
                        },
                    })),
                }
                : {
                    purpose: 'observation_evidence',
                    outcomes: [],
                }
        ));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: vi.fn() })),
            reconcileResource,
        });
        const groupingResource = resource({
            resourceKey: 'sequential-later-links',
        });
        const reconcileGroupingLink = async (index: number) => await (
            reconciler.reconcileLink({
                resource: groupingResource,
                link: {
                    ...link(index),
                    changeObservation: undefined,
                },
                demand: demanded(),
                onFacts: () => {},
            })
        );

        await reconcileGroupingLink(0);
        await vi.waitFor(() => expect(reconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )).toHaveLength(1));
        reconcileResource.mockClear();

        for (let index = 1; index < 25; index += 1) {
            await reconcileGroupingLink(index);
        }

        await vi.waitFor(() => expect(reconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )).toHaveLength(1));
        const [descriptorCall] = reconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        );
        expect(descriptorCall?.[0]).toEqual(
            expect.objectContaining({
                purpose: 'resource_descriptors',
                links: expect.arrayContaining(
                    Array.from({ length: 25 }, (_, index) => (
                        expect.objectContaining({ linkKey: `native-${index}` })
                    )),
                ),
            }),
        );
        expect(descriptorCall?.[0].links).toHaveLength(25);
        await reconciler.dispose();
    });

    it('coalesces bounded-concurrent later grouping links into one complete descriptor pass', async () => {
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => (
            input.purpose === 'resource_descriptors'
                ? {
                    purpose: 'resource_descriptors',
                    outcomes: input.links.map((current) => ({
                        kind: 'described',
                        descriptor: {
                            resourceKey: input.resource.resourceKey,
                            linkKey: current.linkKey,
                            changeObservation: 'reconcile_only',
                        },
                    })),
                }
                : {
                    purpose: 'observation_evidence',
                    outcomes: [],
                }
        ));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: vi.fn() })),
            reconcileResource,
        });
        const groupingResource = resource({
            resourceKey: 'bounded-concurrent-later-links',
        });
        const reconcileGroupingLink = (index: number) => (
            reconciler.reconcileLink({
                resource: groupingResource,
                link: {
                    ...link(index),
                    changeObservation: undefined,
                },
                demand: demanded(),
                onFacts: () => {},
            })
        );

        await reconcileGroupingLink(0);
        await vi.waitFor(() => expect(reconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )).toHaveLength(1));
        reconcileResource.mockClear();

        for (let start = 1; start < 25; start += 4) {
            await Promise.all(
                Array.from(
                    { length: Math.min(4, 25 - start) },
                    (_, offset) => reconcileGroupingLink(start + offset),
                ),
            );
        }

        await vi.waitFor(() => expect(reconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        )).toHaveLength(1));
        const [descriptorCall] = reconcileResource.mock.calls.filter(
            ([input]) => input.purpose === 'resource_descriptors',
        );
        expect(descriptorCall?.[0].links).toHaveLength(25);
        await reconciler.dispose();
    });

    it('coalesces descriptor hydration without scheduling a timer', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const reconcileResource = vi.fn(async (input: Readonly<{
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => ({
            purpose: 'resource_descriptors',
            outcomes: input.links.map((current) => ({
                kind: 'described',
                descriptor: {
                    resourceKey: input.resource.resourceKey,
                    linkKey: current.linkKey,
                    changeObservation: 'reconcile_only',
                },
            })),
        }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: vi.fn() })),
            reconcileResource,
        });

        await reconciler.reconcileLink({
            resource: resource({ resourceKey: 'timer-free-hydration' }),
            link: {
                ...link(1),
                changeObservation: undefined,
            },
            demand: demanded(),
            onFacts: () => {},
        });

        expect(setTimeoutSpy).not.toHaveBeenCalled();
        await reconciler.dispose();
    });

    it('retains no phantom authority when an initial descriptor is unavailable', async () => {
        const acquireObserver = vi.fn(async () => ({ dispose: vi.fn() }));
        const watchFile = vi.fn(() => vi.fn());
        const watchTopologyDirectory = vi.fn(() => vi.fn());
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            links: readonly ExternalSessionObservationLinkIdentity[];
        }>): Promise<TestReconcileResult> => {
            if (input.purpose !== 'resource_descriptors') {
                return result(['native-1', 'must-not-route']);
            }
            return {
                purpose: 'resource_descriptors',
                outcomes: input.links.map((current) => ({
                    kind: 'unavailable',
                    linkKey: current.linkKey,
                })),
            };
        });
        const onFacts = vi.fn();
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            watchFile,
            watchTopologyDirectory,
            reconcileResource,
        });
        const groupingResource = resource({
            resourceKey: 'grouping-only-unavailable',
        });
        const groupingLink = {
            ...link(1),
            changeObservation: undefined,
        };
        const input = {
            resource: groupingResource,
            link: groupingLink,
            demand: demanded(),
            onFacts,
            awaitObserverAdmission: true,
        };

        await expect(reconciler.reconcileLink(input)).resolves.toEqual({
            state: 'reconcile-only',
        });
        await vi.waitFor(() => {
            expect(reconcileResource).toHaveBeenCalledTimes(1);
        });
        await expect(reconciler.reconcileLink(input)).resolves.toEqual({
            state: 'reconcile-only',
        });
        await vi.waitFor(() => {
            expect(reconcileResource).toHaveBeenCalledTimes(2);
        });

        expect(reconcileResource.mock.calls.every(
            ([request]) => request.purpose === 'resource_descriptors',
        )).toBe(true);
        expect(acquireObserver).not.toHaveBeenCalled();
        expect(watchFile).not.toHaveBeenCalled();
        expect(watchTopologyDirectory).not.toHaveBeenCalled();
        expect(onFacts).not.toHaveBeenCalled();
        await reconciler.dispose();
    });

    it('pools 100 links into two observers and routes each link-keyed fact only within its resource', async () => {
        const starts: Array<{
            resource: ExternalSessionObservationResourceIdentity;
            emit: (batch: TestBatch) => void;
            release: ReturnType<typeof vi.fn>;
        }> = [];
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async ({ resource: observedResource, emit }) => {
                const release = vi.fn(async () => {});
                starts.push({ resource: observedResource, emit, release });
                return { dispose: release };
            }),
        });
        const received = Array.from({ length: 100 }, () => [] as TestFact[]);

        await Promise.all(received.map((facts, index) => reconciler.reconcileLink({
            resource: resource({
                resourceKey: index < 50
                    ? 'https://one.example\u0000auth-generation-a'
                    : 'https://two.example\u0000auth-generation-b',
            }),
            link: link(index),
            demand: demanded(),
            onFacts: (receivedFacts) => facts.push(...receivedFacts),
        })));

        expect(starts).toHaveLength(2);

        starts.find((entry) => entry.resource.resourceKey.includes('one.example'))
            ?.emit(batch(['native-0', 'endpoint-one-session-zero']));
        starts.find((entry) => entry.resource.resourceKey.includes('two.example'))
            ?.emit(batch(['native-50', 'endpoint-two-session-fifty']));

        expect(received[0]).toEqual([fact('endpoint-one-session-zero')]);
        expect(received[50]).toEqual([fact('endpoint-two-session-fifty')]);
        expect(received.filter((facts) => facts.length > 0)).toHaveLength(2);

        await Promise.all(received.map((_, index) => reconciler.removeLink(link(index))));
        expect(starts.map((entry) => entry.release.mock.calls.length)).toEqual([1, 1]);
    });

    it('fans one native link key out to multiple current Happier links and drops unknown keys', async () => {
        let emit: ((batch: TestBatch) => void) | undefined;
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                emit = input.emit;
                return { dispose: async () => {} };
            }),
        });
        const first: TestFact[] = [];
        const second: TestFact[] = [];

        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1, { linkKey: 'shared-native-session' }),
            demand: demanded(),
            onFacts: (facts) => first.push(...facts),
        });
        await reconciler.reconcileLink({
            resource: resource(),
            link: link(2, { linkKey: 'shared-native-session' }),
            demand: demanded(),
            onFacts: (facts) => second.push(...facts),
        });

        emit?.(batch(
            ['unknown-native-session', 'must-drop'],
            ['shared-native-session', 'shared'],
        ));

        expect(first).toEqual([fact('shared')]);
        expect(second).toEqual([fact('shared')]);
    });

    it('runs one resource-wide reconciliation for current requested link keys through the same admission map', async () => {
        const reconcileResource = vi.fn(async (input: Readonly<{
            links: readonly Readonly<{
                linkKey: string;
                linkedSource: Readonly<{ remoteSessionId: string }>;
            }>[];
        }>): Promise<TestReconcileResult> => {
            expect(input.links.map((entry) => [
                entry.linkKey,
                entry.linkedSource.remoteSessionId,
            ])).toEqual([
                ['native-a', 'native-1'],
                ['native-shared', 'native-2'],
            ]);
            return result(
                ['native-a', 'a-only'],
                ['native-shared', 'shared'],
            );
        });
        const acquireObserver = vi.fn(async () => ({ dispose: async () => {} }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            reconcileResource,
        });
        const a: TestFact[] = [];
        const sharedOne: TestFact[] = [];
        const sharedTwo: TestFact[] = [];

        for (const [identity, received] of [
            [link(1, { linkKey: 'native-a' }), a],
            [link(2, { linkKey: 'native-shared' }), sharedOne],
            [link(3, { linkKey: 'native-shared' }), sharedTwo],
        ] as const) {
            await reconciler.reconcileLink({
                resource: resource(),
                link: identity,
                demand: demanded({
                    passiveEvent: false,
                    fallbackDemand: true,
                }),
                onFacts: (facts) => received.push(...facts),
            });
        }

        await expect(reconciler.reconcileResource(resource())).resolves.toEqual({
            state: 'reconciled',
            requestedLinkKeys: 2,
        });

        expect(reconcileResource).toHaveBeenCalledTimes(1);
        expect(acquireObserver).not.toHaveBeenCalled();
        expect(a).toEqual([fact('a-only')]);
        expect(sharedOne).toEqual([fact('shared')]);
        expect(sharedTwo).toEqual([fact('shared')]);
    });

    it('does not retain an observer for reconcile-only demand', async () => {
        const release = vi.fn(async () => {});
        const acquireObserver = vi.fn(async () => ({ dispose: release }));
        const reconcileResource = vi.fn(async (): Promise<TestReconcileResult> => result(
            ['native-1', 'reconciled'],
        ));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            reconcileResource,
        });

        await expect(reconciler.reconcileLink({
            resource: resource(),
            link: link(1),
            demand: demanded({
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: true,
            }),
            onFacts: () => {},
        })).resolves.toEqual({ state: 'reconcile-only' });
        await reconciler.reconcileResource(resource());

        expect(acquireObserver).not.toHaveBeenCalled();
        expect(reconcileResource).toHaveBeenCalledTimes(1);
        expect(release).not.toHaveBeenCalled();
    });

    it('coalesces concurrent resource reconciliation and admits only the requested current keys', async () => {
        let resolveReconciliation: ((result: TestReconcileResult) => void) | undefined;
        const reconcileResource = vi.fn(() => new Promise<TestReconcileResult>((resolve) => {
            resolveReconciliation = resolve;
        }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: async () => {} })),
            reconcileResource,
        });
        const received: TestFact[] = [];

        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1, { linkKey: 'requested' }),
            demand: demanded({ passiveEvent: false, fallbackDemand: true }),
            onFacts: (facts) => received.push(...facts),
        });

        const first = reconciler.reconcileResource(resource());
        const second = reconciler.reconcileResource(resource());
        await Promise.resolve();
        resolveReconciliation?.(result(
            ['requested', 'admitted'],
        ));

        await expect(Promise.all([first, second])).resolves.toEqual([
            { state: 'reconciled', requestedLinkKeys: 1 },
            { state: 'reconciled', requestedLinkKeys: 1 },
        ]);
        expect(reconcileResource).toHaveBeenCalledTimes(1);
        expect(received).toEqual([fact('admitted')]);
    });

    it('releases an observer when demand becomes reconcile-only without dropping link admission', async () => {
        const release = vi.fn(async () => {});
        const reconcileResource = vi.fn(async (): Promise<TestReconcileResult> => result(
            ['native-1', 'reconciled-after-release'],
        ));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: release })),
            reconcileResource,
        });
        const received: TestFact[] = [];

        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1),
            demand: demanded(),
            onFacts: (facts) => received.push(...facts),
        });
        await expect(reconciler.reconcileLink({
            resource: resource(),
            link: link(1),
            demand: demanded({ passiveEvent: false, fallbackDemand: true }),
            onFacts: (facts) => received.push(...facts),
        })).resolves.toEqual({ state: 'reconcile-only' });

        expect(release).toHaveBeenCalledTimes(1);
        await reconciler.reconcileResource(resource());
        expect(received).toEqual([fact('reconciled-after-release')]);
    });

    it('coalesces host lifecycle reconcile requests without emitting a resource-scoped fact', async () => {
        let requestReconcile: (() => void) | undefined;
        const reconcileResource = vi.fn(async (input: Readonly<{
            links: readonly Readonly<{
                linkKey: string;
                linkedSource: Readonly<{ remoteSessionId: string }>;
            }>[];
        }>): Promise<TestReconcileResult> => {
            expect(input.links.map((entry) => [
                entry.linkKey,
                entry.linkedSource.remoteSessionId,
            ])).toEqual([
                ['native-1', 'native-1'],
                ['native-2', 'native-2'],
            ]);
            return result(
                ['native-1', 'recovered-one'],
                ['native-2', 'recovered-two'],
            );
        });
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                requestReconcile = input.requestReconcile;
                return { dispose: async () => {} };
            }),
            reconcileResource,
        });
        const first: TestFact[] = [];
        const second: TestFact[] = [];

        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1),
            demand: demanded(),
            onFacts: (facts) => first.push(...facts),
        });
        await reconciler.reconcileLink({
            resource: resource(),
            link: link(2),
            demand: demanded(),
            onFacts: (facts) => second.push(...facts),
        });

        requestReconcile?.();
        requestReconcile?.();

        await vi.waitFor(() => {
            expect(reconcileResource).toHaveBeenCalledTimes(1);
            expect(first).toEqual([fact('recovered-one')]);
            expect(second).toEqual([fact('recovered-two')]);
        });
    });

    it('reconciles current pooled links on their admitted resource after an observer reconnect', async () => {
        const resourceA = resource({
            resourceKey: 'https://one.example\u0000credential-generation-a',
        });
        const requestReconcileByResourceKey = new Map<string, () => void>();
        const emitByResourceKey = new Map<string, (batch: TestBatch) => void>();
        const releasesByResourceKey = new Map<string, ReturnType<typeof vi.fn>>();
        const acquireObserver = vi.fn(async (input: Readonly<{
            resource: ExternalSessionObservationResourceIdentity;
            requestReconcile(): void;
            emit(batch: TestBatch): void;
        }>) => {
            requestReconcileByResourceKey.set(
                input.resource.resourceKey,
                input.requestReconcile,
            );
            emitByResourceKey.set(input.resource.resourceKey, input.emit);
            const release = vi.fn(async () => {});
            releasesByResourceKey.set(input.resource.resourceKey, release);
            return { dispose: release };
        });
        const reconcileResource = vi.fn(async (input: Readonly<{
            purpose: 'observation_evidence' | 'resource_descriptors';
            resource: ExternalSessionObservationResourceIdentity;
            links: readonly Readonly<{
                linkKey: string;
                linkedSource: Readonly<{ remoteSessionId: string }>;
            }>[];
        }>): Promise<TestReconcileResult> => {
            expect(input.purpose).toBe('observation_evidence');
            expect(input.resource.resourceKey).toBe(resourceA.resourceKey);
            expect(input.links.map((entry) => [
                entry.linkKey,
                entry.linkedSource.remoteSessionId,
            ])).toEqual([
                ['native-1', 'native-1'],
                ['native-2', 'native-2'],
            ]);
            return result(
                ['native-1', 'rotated-one'],
                ['native-2', 'rotated-two'],
            );
        });
        const refresh = vi.fn(async () => ({ requested: true } as const));
        const first: TestFact[] = [];
        const second: TestFact[] = [];
        const removed: TestFact[] = [];
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: acquireObserver as never,
            reconcileResource: reconcileResource as never,
            requestTranscriptRefresh: refresh,
            isTranscriptRefreshDemanded: ({ sessionId }) => sessionId === 'session-1',
        });

        for (const [identity, received] of [
            [link(1), first],
            [link(2), second],
            [link(3), removed],
        ] as const) {
            await reconciler.reconcileLink({
                resource: resourceA,
                link: identity,
                demand: demanded(),
                onFacts: (receivedFacts) => received.push(...receivedFacts),
            });
        }
        expect(acquireObserver).toHaveBeenCalledTimes(1);

        await reconciler.removeLink(link(3));
        requestReconcileByResourceKey.get(resourceA.resourceKey)?.();

        await vi.waitFor(() => {
            expect(reconcileResource).toHaveBeenCalledTimes(1);
            expect(first).toEqual([fact('rotated-one')]);
            expect(second).toEqual([fact('rotated-two')]);
        });
        expect(acquireObserver).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledWith({
            sessionId: 'session-1',
            resource: {
                linkGeneration: 'link-1',
                pluginGeneration: '7',
            },
        });
        expect(removed).toEqual([]);

        requestReconcileByResourceKey.get(resourceA.resourceKey)?.();
        emitByResourceKey.get(resourceA.resourceKey)?.(batch(
            ['native-1', 'direct-current-resource'],
        ));
        await vi.waitFor(() => {
            expect(reconcileResource).toHaveBeenCalledTimes(2);
            expect(first).toHaveLength(3);
        });
        expect(first).toEqual([
            fact('rotated-one'),
            fact('direct-current-resource'),
            fact('rotated-one'),
        ]);

        await reconciler.dispose();
        expect(releasesByResourceKey.get(resourceA.resourceKey))
            .toHaveBeenCalledTimes(1);
    });

    it('generation-fences relinked sessions and stale removals within one pooled resource', async () => {
        let emit: ((batch: TestBatch) => void) | undefined;
        const release = vi.fn(async () => {});
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                emit = input.emit;
                return { dispose: release };
            }),
        });
        const received: TestFact[] = [];

        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1, { linkGeneration: 'link-old', linkKey: 'native-old' }),
            demand: demanded(),
            onFacts: (facts) => received.push(...facts),
        });
        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1, { linkGeneration: 'link-new', linkKey: 'native-new' }),
            demand: demanded(),
            onFacts: (facts) => received.push(...facts),
        });

        emit?.(batch(
            ['native-old', 'stale-link'],
            ['native-new', 'current-link'],
        ));
        await expect(reconciler.removeLink(link(1, {
            linkGeneration: 'link-old',
            linkKey: 'native-old',
        }))).resolves.toEqual({ removed: false });
        emit?.(batch(['native-new', 'still-current']));

        expect(received).toEqual([
            fact('current-link'),
            fact('still-current'),
        ]);
        expect(release).not.toHaveBeenCalled();
    });

    it('retains the exact observer until a failed replacement cleanup retries successfully', async () => {
        const cleanupFailure = new Error('observer cleanup rejected');
        const oldDispose = vi.fn()
            .mockRejectedValueOnce(cleanupFailure)
            .mockResolvedValueOnce(undefined);
        const newDispose = vi.fn(async () => {});
        const acquireObserver = vi.fn(async () => ({
            dispose: acquireObserver.mock.calls.length === 1
                ? oldDispose
                : newDispose,
        }));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
        });
        const retiringResource = resource({ resourceKey: 'retiring-resource' });
        const replacementResource = resource({ resourceKey: 'replacement-resource' });
        const retiringLink = link(1, {
            linkGeneration: 'link-retiring',
            linkKey: 'native-retiring',
        });
        const replacementLink = link(1, {
            linkGeneration: 'link-replacement',
            linkKey: 'native-replacement',
        });

        await reconciler.reconcileLink({
            resource: retiringResource,
            link: retiringLink,
            demand: demanded(),
            onFacts: () => {},
        });

        await expect(reconciler.reconcileLink({
            resource: replacementResource,
            link: replacementLink,
            demand: demanded(),
            onFacts: () => {},
        })).rejects.toBe(cleanupFailure);
        expect(oldDispose).toHaveBeenCalledTimes(1);
        expect(acquireObserver).toHaveBeenCalledTimes(1);

        await expect(reconciler.reconcileLink({
            resource: replacementResource,
            link: replacementLink,
            demand: demanded(),
            onFacts: () => {},
        })).resolves.toEqual({ state: 'observing' });
        expect(oldDispose).toHaveBeenCalledTimes(2);
        expect(acquireObserver).toHaveBeenCalledTimes(2);

        await reconciler.dispose();
        expect(newDispose).toHaveBeenCalledTimes(1);
    });

    it('retries the exact observer cleanup when terminal disposal is retried', async () => {
        const cleanupFailure = new Error('observer cleanup rejected');
        const disposeObserver = vi.fn()
            .mockRejectedValueOnce(cleanupFailure)
            .mockResolvedValueOnce(undefined);
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async () => ({ dispose: disposeObserver })),
        });

        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1),
            demand: demanded(),
            onFacts: () => {},
        });

        await expect(reconciler.dispose()).rejects.toBe(cleanupFailure);
        expect(disposeObserver).toHaveBeenCalledTimes(1);

        await expect(reconciler.dispose()).resolves.toBeUndefined();
        expect(disposeObserver).toHaveBeenCalledTimes(2);
    });

    it('does no observer or reconciliation work at zero demand and cleans up once at zero links', async () => {
        const release = vi.fn(async () => {});
        const acquireObserver = vi.fn(async () => ({ dispose: release }));
        const reconcileResource = vi.fn(async (): Promise<TestReconcileResult> => result(
            ['native-1', 'unused'],
        ));
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            reconcileResource,
        });

        await expect(reconciler.reconcileLink({
            resource: resource(),
            link: link(1),
            demand: demanded({
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: false,
            }),
            onFacts: () => {},
        })).resolves.toEqual({ state: 'not-demanded' });
        expect(acquireObserver).not.toHaveBeenCalled();
        expect(reconcileResource).not.toHaveBeenCalled();

        await reconciler.reconcileLink({
            resource: resource(),
            link: link(1),
            demand: demanded(),
            onFacts: () => {},
        });
        await expect(reconciler.removeLink(link(1))).resolves.toEqual({ removed: true });
        await expect(reconciler.removeLink(link(1))).resolves.toEqual({ removed: false });
        await reconciler.dispose();

        expect(release).toHaveBeenCalledTimes(1);
    });
});
