import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionObservationReconcileResourceRequest,
} from '@happier-dev/plugin-sdk/sessions/external';

const runtimeLeaseMocks = vi.hoisted(() => ({
    acquire: vi.fn(),
    activateContributionsOnDemand: vi.fn(async () => []),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMocks.acquire,
}));

import {
    createExternalSessionObservationDaemonProjection,
} from './createExternalSessionObservationDaemonProjection';

describe('createExternalSessionObservationDaemonProjection', () => {
    it('re-describes a canonical watched file and reconciles its replacement resource without transcript work', async () => {
        const root = await mkdtemp(join(tmpdir(), 'observation-daemon-watch-'));
        const sourceRoot = join(root, 'source');
        const rawFilePath = join(sourceRoot, 'session.jsonl');
        await mkdir(sourceRoot, { recursive: true });
        await writeFile(rawFilePath, '{}\n', 'utf8');
        const filePath = await realpath(rawFilePath);
        const watchCallbacks: Array<(file: string) => void> = [];
        const watchDisposals: ReturnType<typeof vi.fn>[] = [];
        const describeResource = vi.fn(() => ({
            resourceKey: 'resource-replaced',
            linkKey: 'native-session-1',
        }));
        const reconcileResource = vi.fn(async (
            request: AgentExternalSessionObservationReconcileResourceRequest,
        ) => request.purpose === 'resource_descriptors'
            ? {
                purpose: 'resource_descriptors' as const,
                outcomes: request.links.map((link) => ({
                    kind: 'described' as const,
                    descriptor: {
                        resourceKey: 'resource-replaced',
                        linkKey: link.linkKey,
                        changeObservation: 'watch_file_changes' as const,
                        watchFileChanges: { files: [filePath] },
                    },
                })),
            }
            : {
                purpose: 'observation_evidence' as const,
                outcomes: request.links.map((link) => ({
                    linkKey: link.linkKey,
                    facts: [{
                        kind: 'recent_activity' as const,
                        evidenceClass: 'reconciliation' as const,
                        observedAtMs: 1_000,
                        expiresAtMs: 2_000,
                    }],
                })),
            });
        const observeResource = vi.fn(async () => ({ dispose() {} }));
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource,
            observeResource,
            reconcileResource,
        };
        const publishField = vi.fn(async () => {});
        const projection = createExternalSessionObservationDaemonProjection({
            publishField,
            acquireObservationContribution: vi.fn(async () => ({
                contribution,
                filesystemReadAllowedPaths: new Set(['']),
                release: async () => {},
            })),
            watchFile: vi.fn((_file, onChange) => {
                watchCallbacks.push(onChange);
                const dispose = vi.fn();
                watchDisposals.push(dispose);
                return dispose;
            }),
            now: () => 1_000,
        });
        const input = {
            resource: {
                pluginId: 'happier.claude',
                agentLocalId: 'claude',
                pluginGeneration: 'plugin-generation-1',
                resourceKey: 'resource-initial',
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                linkKey: 'native-session-1',
                linkedSource: {
                    source: { kind: 'claudeConfig', configDir: sourceRoot },
                    remoteSessionId: 'native-session-1',
                    linkData: {},
                },
                changeObservation: 'watch_file_changes' as const,
                watchFileChanges: { files: [filePath] },
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1 as const,
                    agent: {
                        pluginId: 'happier.claude',
                        localId: 'claude',
                    },
                    source: {
                        kind: 'claudeConfig',
                        contractVersion: 1 as const,
                    },
                },
                linkGeneration: 'link-generation-1',
            },
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            },
        };

        await projection.reconcileLink(input);
        expect(observeResource).not.toHaveBeenCalled();
        expect(watchCallbacks).toHaveLength(1);
        watchCallbacks[0]?.(filePath);

        await vi.waitFor(() => {
            expect(describeResource).not.toHaveBeenCalled();
            expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
                purpose: 'resource_descriptors',
                resourceKey: 'resource-initial',
            }));
            expect(reconcileResource).toHaveBeenCalledWith(expect.objectContaining({
                purpose: 'observation_evidence',
                resourceKey: 'resource-replaced',
            }));
            expect(publishField).toHaveBeenCalledTimes(1);
        });
        expect(watchCallbacks).toHaveLength(2);
        expect(watchDisposals[0]).toHaveBeenCalledTimes(1);

        await projection.dispose();
        expect(watchDisposals[1]).toHaveBeenCalledTimes(1);
    });

    it('rejects an unauthorized topology descriptor batch without partially replacing prior grants', async () => {
        const root = await mkdtemp(join(tmpdir(), 'observation-daemon-topology-'));
        const sourceRoot = join(root, 'source');
        const outsideRoot = join(root, 'outside');
        await mkdir(sourceRoot, { recursive: true });
        await mkdir(outsideRoot, { recursive: true });
        const initialFiles = await Promise.all([1, 2].map(async (index) => {
            const file = join(sourceRoot, `session-${index}.jsonl`);
            await writeFile(file, '{}\n', 'utf8');
            return await realpath(file);
        }));
        const discoveredFile = join(sourceRoot, 'session-1-child.jsonl');
        const unauthorizedFile = join(outsideRoot, 'session-2.jsonl');
        await writeFile(discoveredFile, '{}\n', 'utf8');
        await writeFile(unauthorizedFile, '{}\n', 'utf8');
        const canonicalSourceRoot = await realpath(sourceRoot);
        const canonicalDiscoveredFile = await realpath(discoveredFile);
        const canonicalUnauthorizedFile = await realpath(unauthorizedFile);
        let onTopologyChange: (() => void) | undefined;
        const watchDisposals: ReturnType<typeof vi.fn>[] = [];
        const watchFile = vi.fn((_file: string, _onChange: (file: string) => void) => {
            const dispose = vi.fn();
            watchDisposals.push(dispose);
            return dispose;
        });
        const requestTranscriptRefresh = vi.fn();
        const reconcileResource = vi.fn<
            AgentExternalSessionObservationContribution['reconcileResource']
        >(async (request) => {
            expect(request.purpose).toBe('resource_descriptors');
            return {
                purpose: 'resource_descriptors',
                outcomes: request.links.map((link, index) => ({
                    kind: 'described' as const,
                    descriptor: {
                        resourceKey: 'resource-one',
                        linkKey: link.linkKey,
                        changeObservation: 'watch_file_changes' as const,
                        watchFileChanges: {
                            files: index === 0
                                ? [initialFiles[0]!, canonicalDiscoveredFile]
                                : [canonicalUnauthorizedFile],
                            topologyDirectories: [canonicalSourceRoot],
                        },
                    },
                })),
            };
        });
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource: vi.fn(),
            observeResource: vi.fn(),
            reconcileResource,
        };
        const projection = createExternalSessionObservationDaemonProjection({
            publishField: vi.fn(),
            acquireObservationContribution: vi.fn(async () => ({
                contribution,
                filesystemReadAllowedPaths: new Set(['']),
                release: async () => {},
            })),
            watchFile,
            watchTopologyDirectory: vi.fn((_directory, callback) => {
                onTopologyChange = callback;
                return vi.fn();
            }),
            requestTranscriptRefresh,
            isTranscriptRefreshDemanded: () => true,
        });
        const linkedSource = {
            source: { kind: 'claudeConfig' as const, configDir: sourceRoot },
            remoteSessionId: 'native-session',
            linkData: {},
        };
        for (const index of [0, 1]) {
            await projection.reconcileLink({
                resource: {
                    pluginId: 'happier.claude',
                    agentLocalId: 'claude',
                    pluginGeneration: 'plugin-generation-1',
                    resourceKey: 'resource-one',
                },
                link: {
                    sessionId: `session-${index + 1}`,
                    linkGeneration: `link-generation-${index + 1}`,
                    linkKey: `native-session-${index + 1}`,
                    linkedSource: {
                        ...linkedSource,
                        remoteSessionId: `native-session-${index + 1}`,
                    },
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: {
                        files: [initialFiles[index]!],
                        topologyDirectories: [canonicalSourceRoot],
                    },
                },
                target: {
                    qualifiedLinkIdentity: {
                        v: 1,
                        agent: {
                            pluginId: 'happier.claude',
                            localId: 'claude',
                        },
                        source: {
                            kind: 'claudeConfig',
                            contractVersion: 1,
                        },
                    },
                    linkGeneration: `link-generation-${index + 1}`,
                },
                demand: {
                    passiveEvent: true,
                    persistedPolicy: false,
                    fallbackDemand: false,
                    transcriptDemand: true,
                },
            });
        }

        expect(watchFile).toHaveBeenCalledTimes(2);
        onTopologyChange?.();

        await vi.waitFor(() => expect(reconcileResource).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(watchFile).toHaveBeenCalledTimes(2);
        expect(watchDisposals.every((dispose) => (
            dispose.mock.calls.length === 0
        ))).toBe(true);
        expect(requestTranscriptRefresh).not.toHaveBeenCalled();

        await projection.dispose();
        for (const dispose of watchDisposals) {
            expect(dispose).toHaveBeenCalledTimes(1);
        }
    });

    it('reconciles reconcile-only demand without acquiring an inert observer', async () => {
        const observeResource = vi.fn(async () => ({ dispose() {} }));
        const reconcileResource = vi.fn<
            AgentExternalSessionObservationContribution['reconcileResource']
        >(async () => ({
            purpose: 'observation_evidence',
            outcomes: [],
        }));
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource: vi.fn(),
            observeResource,
            reconcileResource,
        };
        const projection = createExternalSessionObservationDaemonProjection({
            publishField: vi.fn(),
            acquireObservationContribution: vi.fn(async () => ({
                contribution,
                release: async () => {},
            })),
        });
        const resolved = {
            resource: {
                pluginId: 'happier.oh-my-pi',
                agentLocalId: 'ohmypi',
                pluginGeneration: 'plugin-generation-1',
                resourceKey: 'omp-resource',
            },
            link: {
                sessionId: 'session-omp',
                linkGeneration: 'link-generation-1',
                linkKey: 'native-session-omp',
                linkedSource: {
                    source: { kind: 'ohmypi.server' },
                    remoteSessionId: 'native-session-omp',
                    linkData: {},
                },
                changeObservation: 'reconcile_only' as const,
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1 as const,
                    agent: {
                        pluginId: 'happier.oh-my-pi',
                        localId: 'ohmypi',
                    },
                    source: {
                        kind: 'ohmypi.server',
                        contractVersion: 1 as const,
                    },
                },
                linkGeneration: 'link-generation-1',
            },
        };

        await projection.reconcileLink({
            ...resolved,
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            },
        });
        await projection.reconcileFallbackDemandBatch([{
            sessionId: resolved.link.sessionId,
            linkGeneration: resolved.link.linkGeneration,
            resolved,
            demanded: true,
        }]);

        expect(observeResource).not.toHaveBeenCalled();
        expect(reconcileResource).toHaveBeenCalledTimes(1);
        await projection.dispose();
    });

    it('returns a temporary one-shot reduction without publishing from the read-only status path', async () => {
        vi.useFakeTimers();
        const publishField = vi.fn<
            (input: Readonly<{ sessionId: string }>) => Promise<void>
        >(async () => {});
        const release = vi.fn(async () => {});
        const reconcileResource =
            vi.fn<AgentExternalSessionObservationContribution['reconcileResource']>(
                async (request) => {
                    expect(release).toHaveBeenCalledTimes(1);
                    return {
                        purpose: 'observation_evidence' as const,
                        outcomes: request.links.map((link) => ({
                            linkKey: link.linkKey,
                            facts: [{
                                kind: 'turn_phase' as const,
                                evidenceClass: 'agent_native' as const,
                                value: 'working' as const,
                                observedAtMs: 1_000,
                                expiresAtMs: 2_000,
                            }],
                        })),
                    };
                },
            );
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource: vi.fn(),
            observeResource: vi.fn(),
            reconcileResource,
        };
        const projection = createExternalSessionObservationDaemonProjection({
            publishField,
            acquireObservationContribution: vi.fn(async () => ({
                contribution,
                release,
            })),
            now: () => 1_000,
        });

        const result = await projection.reconcileStatusLink({
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
                changeObservation: 'reconcile_only' as const,
            },
            target: {
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
                linkGeneration: 'link-generation-1',
            },
        });
        await projection.flush();

        expect(result.snapshot?.status).toBe('working');
        expect(reconcileResource).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(publishField).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();
        await projection.flush();
        expect(publishField).not.toHaveBeenCalled();

        await projection.dispose();
        vi.useRealTimers();
    });

    it('keeps publication on a pre-existing demanded projection while status reconciles it', async () => {
        const publishField = vi.fn<
            (input: Readonly<{ sessionId: string }>) => Promise<void>
        >(async () => {});
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource: vi.fn(),
            observeResource: vi.fn(),
            reconcileResource: vi.fn<
                AgentExternalSessionObservationContribution['reconcileResource']
            >(async (request) => ({
                purpose: 'observation_evidence',
                outcomes: request.links.map((link) => ({
                    linkKey: link.linkKey,
                    facts: [{
                        kind: 'turn_phase',
                        evidenceClass: 'agent_native',
                        value: 'working',
                        observedAtMs: 1_000,
                        expiresAtMs: 2_000,
                    }],
                })),
            })),
        };
        const projection = createExternalSessionObservationDaemonProjection({
            publishField,
            acquireObservationContribution: vi.fn(async () => ({
                contribution,
                release: async () => {},
            })),
            now: () => 1_000,
        });
        const input = {
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
                changeObservation: 'observe_resource' as const,
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1 as const,
                    agent: {
                        pluginId: 'happier.opencode',
                        localId: 'opencode',
                    },
                    source: {
                        kind: 'opencode.server',
                        contractVersion: 1 as const,
                    },
                },
                linkGeneration: 'link-generation-1',
            },
        };
        await projection.reconcileLink({
            ...input,
            demand: {
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: true,
            },
        });

        const result = await projection.reconcileStatusLink(input);
        await projection.flush();

        expect(result.snapshot?.status).toBe('working');
        expect(publishField).toHaveBeenCalledTimes(1);
        await projection.dispose();
    });

    it('resolves a qualified plugin-local Agent identity to its global runtime id', async () => {
        const reconcileResource = vi.fn(async () => ({
            purpose: 'observation_evidence' as const,
            outcomes: [],
        }));
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource: vi.fn(),
            observeResource: vi.fn(),
            reconcileResource,
        };
        const release = vi.fn(async () => {});
        runtimeLeaseMocks.acquire.mockResolvedValueOnce({
            registry: {
                contributes: {
                    agentDefinitionsById: new Map([[
                        'ohMyPi',
                        {
                            id: 'ohMyPi',
                            pluginId: 'happier.oh-my-pi',
                            identity: {
                                pluginId: 'happier.oh-my-pi',
                                localId: 'ohmypi',
                            },
                        },
                    ]]),
                },
                activateContributionsOnDemand: runtimeLeaseMocks.activateContributionsOnDemand,
                agentRuntimesByAgentId: new Map([[
                    'ohMyPi',
                    {
                        agentId: 'ohMyPi',
                        pluginId: 'happier.oh-my-pi',
                        generation: 'plugin-generation-1',
                        isCurrent: () => true,
                        externalSessionObservation: contribution,
                    },
                ]]),
            },
            release,
        });
        const projection = createExternalSessionObservationDaemonProjection();

        const result = await projection.reconcileStatusLink({
            resource: {
                pluginId: 'happier.oh-my-pi',
                agentLocalId: 'ohmypi',
                pluginGeneration: 'plugin-generation-1',
                resourceKey: 'endpoint-one',
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: 'link-generation-1',
                linkKey: 'native-session-1',
                linkedSource: {
                    source: { kind: 'ohmypi.server' },
                    remoteSessionId: 'native-session-1',
                    linkData: {},
                },
                changeObservation: 'reconcile_only' as const,
            },
            target: {
                qualifiedLinkIdentity: {
                    v: 1,
                    agent: {
                        pluginId: 'happier.oh-my-pi',
                        localId: 'ohmypi',
                    },
                    source: {
                        kind: 'ohmypi.server',
                        contractVersion: 1,
                    },
                },
                linkGeneration: 'link-generation-1',
            },
        });

        expect(result.snapshot).toBeNull();
        expect(runtimeLeaseMocks.activateContributionsOnDemand).toHaveBeenCalledWith([{
            pluginId: 'happier.oh-my-pi',
            family: 'agents',
            localId: 'ohmypi',
        }]);
        expect(reconcileResource).toHaveBeenCalledTimes(1);
        expect(release.mock.invocationCallOrder[0])
            .toBeLessThan(reconcileResource.mock.invocationCallOrder[0]!);
        await projection.dispose();
    });

    it('releases registry custody before a pending generation-bound observer acquisition', async () => {
        let releaseAcquisition: (
            observer: Readonly<{ dispose(): Promise<void> }>,
        ) => void = () => {};
        const acquisition = new Promise<Readonly<{ dispose(): Promise<void> }>>(
            (resolve) => {
                releaseAcquisition = resolve;
            },
        );
        const retirement = new AbortController();
        let observedSignal: AbortSignal | null = null;
        let markObserveStarted: () => void = () => {};
        const observeStarted = new Promise<void>((resolve) => {
            markObserveStarted = resolve;
        });
        const lateDispose = vi.fn(async () => {});
        const contribution: AgentExternalSessionObservationContribution = {
            describeResource: vi.fn(),
            async observeResource(request) {
                observedSignal = request.signal;
                markObserveStarted();
                return await acquisition;
            },
            reconcileResource: vi.fn(),
        };
        let markRegistryReleased: () => void = () => {};
        const registryReleased = new Promise<void>((resolve) => {
            markRegistryReleased = resolve;
        });
        const release = vi.fn(async () => {
            markRegistryReleased();
        });
        const projection = createExternalSessionObservationDaemonProjection({
            publishField: vi.fn(),
            acquireObservationContribution: vi.fn(async () => ({
                contribution,
                retirementSignal: retirement.signal,
                release,
            })),
        });

        const reconcile = projection.reconcileLink({
            resource: {
                pluginId: 'happier.opencode',
                agentLocalId: 'opencode',
                pluginGeneration: 'plugin-generation-1',
                resourceKey: 'endpoint-one',
                retirementSignal: retirement.signal,
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
                changeObservation: 'observe_resource' as const,
            },
            target: {
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
                linkGeneration: 'link-generation-1',
            },
            demand: {
                passiveEvent: true,
                persistedPolicy: false,
                fallbackDemand: false,
            },
        });
        await registryReleased;
        await observeStarted;
        expect(release).toHaveBeenCalledTimes(1);

        retirement.abort();
        expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);
        releaseAcquisition({ dispose: lateDispose });
        await expect(reconcile).resolves.toEqual({ state: 'superseded' });
        expect(lateDispose).toHaveBeenCalledTimes(1);

        await projection.dispose();
    });
});
