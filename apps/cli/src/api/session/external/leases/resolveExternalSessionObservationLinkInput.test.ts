import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    createBoundedAgentExternalSessionsContribution,
} from '@/session/external/agentExternalSessionsInvocation';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

const mocks = vi.hoisted(() => ({
    acquireRuntimeRegistryLease: vi.fn(),
    activateContributionsOnDemand: vi.fn(async () => []),
    describeResource: vi.fn(),
    observeResource: vi.fn(),
    pageTranscript: vi.fn(),
    readAfterTranscript: vi.fn(),
    release: vi.fn(async () => {}),
    resolveLinkedIdentity: vi.fn(),
}));
const unavailableInvocationExec = createUnavailablePluginServices().exec;

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: mocks.acquireRuntimeRegistryLease,
}));

import {
    resolveExternalSessionObservationLinkInput,
    type ExternalSessionObservationLinkedSession,
} from './resolveExternalSessionObservationLinkInput';
import {
    validateExternalSessionObservationWatchFileChanges,
} from '@/session/external/observationFileSetPathValidation';

const qualifiedLinkIdentity = {
    v: 1,
    agent: {
        pluginId: 'happier.opencode',
        localId: 'opencode',
    },
    source: {
        kind: 'opencodeServer',
        contractVersion: 1,
    },
} as const;

const linked = {
    agentId: 'opencode',
    remoteSessionId: 'remote-1',
    linkGeneration: '1000',
    source: {
        kind: 'opencodeServer',
        directory: null,
    },
    metadata: {
        externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: {
                kind: 'opencodeServer',
                directory: null,
            },
            qualifiedIdentity: qualifiedLinkIdentity,
            linkData: { endpoint: 'default' },
            linkedAtMs: 1_000,
        },
    },
} as const satisfies ExternalSessionObservationLinkedSession;

const connectedLinked = {
    agentId: 'codex',
    remoteSessionId: 'remote-connected',
    linkGeneration: '2000',
    source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/connected-codex-home',
    },
    metadata: {
        externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-connected',
            source: {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'work',
                homePath: '/tmp/connected-codex-home',
            },
            qualifiedIdentity: {
                v: 1,
                agent: {
                    pluginId: 'happier.codex',
                    localId: 'codex',
                },
                source: {
                    kind: 'codexHome',
                    contractVersion: 1,
                },
            },
            linkedAtMs: 2_000,
        },
    },
} as const satisfies ExternalSessionObservationLinkedSession;

function installRuntime(options: Readonly<{
    current?: boolean;
    externalSessions?: AgentExternalSessionsContribution;
    pluginId?: string;
}> = {}): void {
    mocks.acquireRuntimeRegistryLease.mockResolvedValue({
        registry: {
            contributes: {
                agentDefinitionsById: new Map([[
                    'opencode',
                    {
                        id: 'opencode',
                        pluginId: 'happier.opencode',
                        identity: qualifiedLinkIdentity.agent,
                        richDefinition: {
                            definition: {
                                surfaces: {
                                    externalSession: {
                                        sources: [{
                                            sourceKind: 'opencodeServer',
                                            schema: {
                                                fields: [
                                                    { name: 'kind', kind: 'literal', value: 'opencodeServer' },
                                                    { name: 'directory', kind: 'string', optional: true, nullish: true },
                                                ],
                                            },
                                            key: {
                                                segments: [
                                                    { kind: 'literal', value: 'opencodeServer' },
                                                    { kind: 'field', field: 'directory' },
                                                ],
                                            },
                                        }],
                                    },
                                },
                            },
                        },
                    },
                ]]),
            },
            activateContributionsOnDemand: mocks.activateContributionsOnDemand,
            agentRuntimesByAgentId: new Map([[
                'opencode',
                {
                    pluginId: options.pluginId ?? 'happier.opencode',
                    agentId: 'opencode',
                    generation: 'plugin-generation-1',
                    isCurrent: () => options.current ?? true,
                    externalSessions: options.externalSessions ?? {
                        resolveLinkedIdentity: mocks.resolveLinkedIdentity,
                        pageTranscript: mocks.pageTranscript,
                        readAfterTranscript: mocks.readAfterTranscript,
                    },
                    externalSessionObservation: {
                        describeResource: mocks.describeResource,
                        observeResource: mocks.observeResource,
                    },
                },
            ]]),
        },
        release: mocks.release,
    });
}

function installConnectedRuntime(): void {
    mocks.acquireRuntimeRegistryLease.mockResolvedValue({
        registry: {
            contributes: {
                agentDefinitionsById: new Map([[
                    'codex',
                    {
                        id: 'codex',
                        pluginId: 'happier.codex',
                        identity: connectedLinked.metadata.externalSessionV1.qualifiedIdentity.agent,
                        richDefinition: {
                            definition: {
                                surfaces: {
                                    externalSession: {
                                        sources: [{
                                            sourceKind: 'codexHome',
                                            schema: {
                                                fields: [
                                                    { name: 'kind', kind: 'literal', value: 'codexHome' },
                                                    { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
                                                    { name: 'connectedServiceId', kind: 'string', optional: true },
                                                    { name: 'connectedServiceProfileId', kind: 'string', optional: true },
                                                    { name: 'homePath', kind: 'string', optional: true },
                                                ],
                                            },
                                            key: {
                                                segments: [{ kind: 'literal', value: 'codexHome' }],
                                            },
                                            instances: [{
                                                kind: 'connectedServiceProfiles',
                                                serviceId: 'openai-codex',
                                                constants: { home: 'connectedService' },
                                                fields: {
                                                    serviceId: 'connectedServiceId',
                                                    profileId: 'connectedServiceProfileId',
                                                },
                                            }],
                                        }],
                                    },
                                },
                            },
                        },
                    },
                ]]),
            },
            activateContributionsOnDemand: mocks.activateContributionsOnDemand,
            agentRuntimesByAgentId: new Map([[
                'codex',
                {
                    pluginId: 'happier.codex',
                    agentId: 'codex',
                    generation: 'plugin-generation-1',
                    isCurrent: () => true,
                    externalSessions: {
                        resolveLinkedIdentity: mocks.resolveLinkedIdentity,
                        pageTranscript: mocks.pageTranscript,
                        readAfterTranscript: mocks.readAfterTranscript,
                    },
                    externalSessionObservation: {
                        describeResource: mocks.describeResource,
                        observeResource: mocks.observeResource,
                    },
                },
            ]]),
        },
        release: mocks.release,
    });
}

describe('resolveExternalSessionObservationLinkInput', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        installRuntime();
        mocks.resolveLinkedIdentity.mockResolvedValue({
            ok: true,
            value: {
                source: linked.source,
                remoteSessionId: linked.remoteSessionId,
                linkData: { endpoint: 'default' },
            },
        });
        mocks.describeResource.mockReturnValue({
            resourceKey: 'endpoint-default',
            linkKey: 'remote-1',
        });
    });

    it('resolves the current qualified generation without starting observation or transcript work', async () => {
        await expect(resolveExternalSessionObservationLinkInput({
            linked,
            sessionId: 'session-1',
        })).resolves.toEqual({
            resource: {
                pluginId: 'happier.opencode',
                agentLocalId: 'opencode',
                pluginGeneration: 'plugin-generation-1',
                resourceKey: 'endpoint-default',
            },
            link: {
                sessionId: 'session-1',
                linkGeneration: '1000',
                linkKey: 'remote-1',
                linkedSource: {
                    source: linked.source,
                    remoteSessionId: 'remote-1',
                    linkData: { endpoint: 'default' },
                },
            },
            target: {
                qualifiedLinkIdentity,
                linkGeneration: '1000',
            },
        });
        expect(mocks.release).toHaveBeenCalledOnce();
        expect(mocks.activateContributionsOnDemand).toHaveBeenCalledWith([{
            pluginId: 'happier.opencode',
            family: 'agents',
            localId: 'opencode',
        }]);
        expect(mocks.observeResource).not.toHaveBeenCalled();
        expect(mocks.pageTranscript).not.toHaveBeenCalled();
        expect(mocks.readAfterTranscript).not.toHaveBeenCalled();
    });

    it('fails closed before leaf invocation when the runtime generation is no longer current', async () => {
        installRuntime({ current: false });

        await expect(resolveExternalSessionObservationLinkInput({
            linked,
            sessionId: 'session-1',
        })).resolves.toBeNull();
        expect(mocks.resolveLinkedIdentity).not.toHaveBeenCalled();
        expect(mocks.describeResource).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('fails closed when linked-identity rehydration rejects a no-longer-current configured source', async () => {
        mocks.resolveLinkedIdentity.mockResolvedValueOnce({
            ok: false,
            code: 'source_invalid',
            retryable: false,
        });

        await expect(resolveExternalSessionObservationLinkInput({
            linked,
            sessionId: 'session-1',
        })).resolves.toBeNull();

        expect(mocks.resolveLinkedIdentity).toHaveBeenCalledOnce();
        expect(mocks.describeResource).not.toHaveBeenCalled();
    });

    it('fails closed when linked-identity hydration rewrites the current same-kind source', async () => {
        mocks.resolveLinkedIdentity.mockResolvedValueOnce({
            ok: true,
            value: {
                source: {
                    ...linked.source,
                    directory: '/different-project',
                },
                remoteSessionId: linked.remoteSessionId,
                linkData: { endpoint: 'default' },
            },
        });

        await expect(resolveExternalSessionObservationLinkInput({
            linked,
            sessionId: 'session-1',
        })).resolves.toBeNull();

        expect(mocks.resolveLinkedIdentity).toHaveBeenCalledOnce();
        expect(mocks.describeResource).not.toHaveBeenCalled();
    });

    it('fails closed when linked-identity hydration rewrites the remote session', async () => {
        mocks.resolveLinkedIdentity.mockResolvedValueOnce({
            ok: true,
            value: {
                source: linked.source,
                remoteSessionId: 'remote-other',
                linkData: { endpoint: 'default' },
            },
        });

        await expect(resolveExternalSessionObservationLinkInput({
            linked,
            sessionId: 'session-1',
        })).resolves.toBeNull();

        expect(mocks.resolveLinkedIdentity).toHaveBeenCalledOnce();
        expect(mocks.describeResource).not.toHaveBeenCalled();
    });

    it('fails closed and releases registry custody when Agent activation fails', async () => {
        mocks.activateContributionsOnDemand.mockRejectedValueOnce(
            new Error('activation unavailable'),
        );

        await expect(resolveExternalSessionObservationLinkInput({
            linked,
            sessionId: 'session-1',
        })).resolves.toBeNull();
        expect(mocks.release).toHaveBeenCalledOnce();
        expect(mocks.resolveLinkedIdentity).not.toHaveBeenCalled();
    });

    it('fails closed when the resolved source does not match the persisted qualified source', async () => {
        mocks.resolveLinkedIdentity.mockResolvedValue({
            ok: true,
            value: {
                source: {
                    kind: 'claudeCode',
                    machineId: 'machine-1',
                    path: '/tmp/project',
                },
                remoteSessionId: linked.remoteSessionId,
                linkData: {},
            },
        });

        await expect(resolveExternalSessionObservationLinkInput({
            linked,
            sessionId: 'session-1',
        })).resolves.toBeNull();
        expect(mocks.describeResource).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('rejects a declaration-owned connected profile when the current account projection is disconnected', async () => {
        installConnectedRuntime();
        mocks.resolveLinkedIdentity.mockResolvedValueOnce({
            ok: true,
            value: {
                source: connectedLinked.source,
                remoteSessionId: connectedLinked.remoteSessionId,
                linkData: {},
            },
        });

        await expect(resolveExternalSessionObservationLinkInput({
            linked: connectedLinked,
            sessionId: 'session-connected',
            accountProjection: {
                connectedServicesV2: [{
                    serviceId: 'openai-codex',
                    profiles: [{
                        profileId: 'work',
                        status: 'disconnected',
                    }],
                }],
            },
        })).resolves.toBeNull();

        expect(mocks.resolveLinkedIdentity).toHaveBeenCalledOnce();
        expect(mocks.describeResource).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('fails closed before observation grouping when a rehydrated connected-profile source mismatches its declared service', async () => {
        installConnectedRuntime();
        const mismatchedConnectedLinked = {
            ...connectedLinked,
            source: {
                ...connectedLinked.source,
                connectedServiceId: 'different-service',
            },
            metadata: {
                externalSessionV1: {
                    ...connectedLinked.metadata.externalSessionV1,
                    source: {
                        ...connectedLinked.metadata.externalSessionV1.source,
                        connectedServiceId: 'different-service',
                    },
                },
            },
        } as ExternalSessionObservationLinkedSession;
        mocks.resolveLinkedIdentity.mockResolvedValueOnce({
            ok: true,
            value: {
                source: mismatchedConnectedLinked.source,
                remoteSessionId: mismatchedConnectedLinked.remoteSessionId,
                linkData: {},
            },
        });

        await expect(resolveExternalSessionObservationLinkInput({
            linked: mismatchedConnectedLinked,
            sessionId: 'session-connected',
            accountProjection: {
                connectedServicesV2: [{
                    serviceId: 'openai-codex',
                    profiles: [{
                        profileId: 'work',
                        status: 'connected',
                    }],
                }],
            },
        })).resolves.toBeNull();

        expect(mocks.resolveLinkedIdentity).toHaveBeenCalledOnce();
        expect(mocks.describeResource).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('releases registry custody before plugin work and rejects a late retired result', async () => {
        const order: string[] = [];
        let active = true;
        const retirement = new AbortController();
        let settleResolve!: (
            result: Awaited<ReturnType<AgentExternalSessionsContribution['resolveLinkedIdentity']>>,
        ) => void;
        const resolveLinkedIdentity = vi.fn(async () => {
            order.push('resolve-start');
            return await new Promise<
                Awaited<ReturnType<AgentExternalSessionsContribution['resolveLinkedIdentity']>>
            >((resolve) => {
                settleResolve = resolve;
            });
        });
        const unsupported = vi.fn(async () => ({
            ok: false as const,
            code: 'unsupported' as const,
        }));
        const bounded = createBoundedAgentExternalSessionsContribution({
            contribution: {
                resolveSource: unsupported,
                listCandidates: unsupported,
                resolveLinkIdentity: unsupported,
                resolveLinkedIdentity,
                pageTranscript: unsupported,
                readAfterTranscript: unsupported,
            },
            identity: {
                pluginId: 'happier.opencode',
                agentId: 'opencode',
                generation: 'plugin-generation-1',
                contributionQualifiedId:
                    'happier.opencode/agents/opencode',
                immutableGenerationId: 'immutable-generation-1',
            },
            isCurrent: () => active,
            retirementSignal: retirement.signal,
            createInvocationExec: async () => unavailableInvocationExec,
        });
        installRuntime({ externalSessions: bounded });
        mocks.release.mockImplementationOnce(async () => {
            order.push('release');
        });

        const resolving = resolveExternalSessionObservationLinkInput({
            linked,
            sessionId: 'session-1',
        });
        await vi.waitFor(() => {
            expect(resolveLinkedIdentity).toHaveBeenCalledOnce();
        });
        active = false;
        retirement.abort();
        settleResolve({
            ok: true,
            value: {
                source: linked.source,
                remoteSessionId: linked.remoteSessionId,
                linkData: { endpoint: 'default' },
            },
        });

        await expect(resolving).resolves.toBeNull();
        expect(order).toEqual(['release', 'resolve-start']);
        expect(mocks.describeResource).not.toHaveBeenCalled();
    });
});

describe('external-session observation file-watch authorization', () => {
    it('admits only canonical files inside a resolved source root with filesystem-read entitlement', async () => {
        const root = await mkdtemp(join(tmpdir(), 'external-observation-watch-'));
        const sourceRoot = join(root, 'source');
        const outsideRoot = join(root, 'outside');
        const filePath = join(sourceRoot, 'session.jsonl');
        const outsidePath = join(outsideRoot, 'session.jsonl');
        await mkdir(sourceRoot, { recursive: true });
        await mkdir(outsideRoot, { recursive: true });
        await writeFile(filePath, '{}\n', 'utf8');
        await writeFile(outsidePath, '{}\n', 'utf8');
        const canonicalFilePath = await realpath(filePath);
        const linkedSource = {
            source: { kind: 'fixture', configDir: sourceRoot },
            remoteSessionId: 'native-session',
            linkData: {},
        };

        expect(validateExternalSessionObservationWatchFileChanges({
            requested: { files: [filePath] },
            linkedSource,
            filesystemReadAllowedPaths: new Set(['']),
        })).toEqual({ files: [canonicalFilePath] });
        expect(validateExternalSessionObservationWatchFileChanges({
            requested: { files: [filePath] },
            linkedSource,
            filesystemReadAllowedPaths: new Set(),
        })).toBeNull();
        await unlink(filePath);
        expect(validateExternalSessionObservationWatchFileChanges({
            requested: { files: [canonicalFilePath] },
            linkedSource,
            filesystemReadAllowedPaths: new Set(['']),
            previouslyAuthorizedFiles: new Set([canonicalFilePath]),
        })).toEqual({ files: [canonicalFilePath] });
        expect(validateExternalSessionObservationWatchFileChanges({
            requested: { files: [outsidePath] },
            linkedSource,
            filesystemReadAllowedPaths: new Set(['']),
        })).toBeNull();
        expect(validateExternalSessionObservationWatchFileChanges({
            requested: { files: [filePath] },
            linkedSource: {
                ...linkedSource,
                source: { kind: 'fixture', endpoint: 'https://example.test' },
            },
            filesystemReadAllowedPaths: new Set(['']),
        })).toBeNull();
    });

    it('retains an already-authorized file-owned source across deletion until canonical recreation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'external-observation-file-source-'));
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{}\n', 'utf8');
        const canonicalFilePath = await realpath(filePath);
        const linkedSource = {
            source: { kind: 'fixture', transcriptPath: canonicalFilePath },
            remoteSessionId: 'native-session',
            linkData: {},
        };

        expect(validateExternalSessionObservationWatchFileChanges({
            requested: { files: [canonicalFilePath] },
            linkedSource,
            filesystemReadAllowedPaths: new Set(['']),
        })).toEqual({ files: [canonicalFilePath] });

        await unlink(filePath);

        expect(validateExternalSessionObservationWatchFileChanges({
            requested: { files: [canonicalFilePath] },
            linkedSource,
            filesystemReadAllowedPaths: new Set(['']),
            previouslyAuthorizedFiles: new Set([canonicalFilePath]),
        })).toEqual({ files: [canonicalFilePath] });
    });
});
