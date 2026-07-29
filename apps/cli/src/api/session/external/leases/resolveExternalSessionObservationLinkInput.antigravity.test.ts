import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    buildLinkedExternalSessionQualifiedIdentityV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import {
    resolveExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const runtimeLeaseMocks = vi.hoisted(() => ({
    acquire: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMocks.acquire,
}));

import {
    createExternalSessionObservationDaemonProjection,
} from './createExternalSessionObservationDaemonProjection';
import {
    resolveExternalSessionObservationLinkInput,
    type ExternalSessionObservationLinkedSession,
} from './resolveExternalSessionObservationLinkInput';

const ANTIGRAVITY_AGENT_ID = 'antigravity';
const ANTIGRAVITY_PLUGIN_ID = 'happier.agent.antigravity';

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

describe('Antigravity production observation admission', () => {
    afterEach(() => {
        runtimeLeaseMocks.acquire.mockReset();
    });

    it('projects filesystem-read authority and admits only the canonical linked transcript', async () => {
        await withTempDir('happier-antigravity-observation-admission-', async (directory) => {
            const home = join(directory, 'home');
            const conversationId = 'antigravity-observation-admission';
            const transcriptDirectory = join(
                home,
                '.gemini',
                'antigravity-cli',
                'brain',
                conversationId,
                '.system_generated',
                'logs',
            );
            const transcriptPath = join(
                transcriptDirectory,
                'transcript_full.jsonl',
            );
            const outsidePath = join(directory, 'outside.jsonl');
            await mkdir(transcriptDirectory, { recursive: true });
            await writeFile(
                transcriptPath,
                line({
                    step_index: 1,
                    type: 'USER_INPUT',
                    text: 'sanitized fixture',
                }),
                'utf8',
            );
            await writeFile(outsidePath, line({ type: 'USER_INPUT' }), 'utf8');

            const envScope = createEnvKeyScope(['HOME', 'USERPROFILE']);
            envScope.patch({ HOME: home, USERPROFILE: undefined });
            let runtimeRegistry: Awaited<
                ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
            > | null = null;
            try {
                runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
                    contributes: createResolvedContributionRegistry(
                        resolveBuiltInContributions(),
                    ),
                    happyHomeDir: join(directory, 'happier-home'),
                    pluginIds: [ANTIGRAVITY_PLUGIN_ID],
                });
                runtimeLeaseMocks.acquire.mockImplementation(async () => ({
                    registry: runtimeRegistry,
                    source: 'active',
                    release: async () => {},
                }));

                const resolution = await resolveBackendEngineAdapterResolution(
                    ANTIGRAVITY_AGENT_ID,
                    { runtimeRegistry },
                );
                const externalSession =
                    resolution?.executionSurfaces.externalSession;
                if (!externalSession) {
                    throw new Error(
                        'Expected Antigravity External Sessions execution surface',
                    );
                }
                const source = { kind: 'antigravityCliPrint' } as never;
                const candidates = await externalSession.listCandidates!({
                    source,
                    limit: 1,
                });
                const candidate = candidates.candidates[0];
                if (!candidate?.linkData) {
                    throw new Error(
                        'Expected a source-qualified Antigravity candidate',
                    );
                }
                const resolvedLink = await externalSession.resolveLinkIdentity!({
                    source,
                    remoteSessionId: candidate.remoteSessionId,
                    metadata: {
                        linkData: candidate.linkData,
                    },
                });
                const qualifiedIdentity =
                    buildLinkedExternalSessionQualifiedIdentityV1({
                        agent: {
                            pluginId: ANTIGRAVITY_PLUGIN_ID,
                            localId: ANTIGRAVITY_AGENT_ID,
                        },
                        sourceKind: 'antigravityCliPrint',
                    });
                const linked = {
                    agentId: ANTIGRAVITY_AGENT_ID,
                    remoteSessionId: resolvedLink.remoteSessionId,
                    linkGeneration: '1000',
                    source: resolvedLink.source,
                    metadata: {
                        externalSessionV1: {
                            v: 1,
                            agentId: ANTIGRAVITY_AGENT_ID,
                            machineId: 'machine-1',
                            remoteSessionId: resolvedLink.remoteSessionId,
                            source: resolvedLink.source,
                            qualifiedIdentity,
                            linkData: candidate.linkData,
                            linkedAtMs: 1_000,
                        },
                    },
                } satisfies ExternalSessionObservationLinkedSession;

                expect(
                    runtimeRegistry.filesystemReadAllowedPathsByPluginId?.get(
                        ANTIGRAVITY_PLUGIN_ID,
                    ),
                ).toEqual(new Set(['']));
                const resolved =
                    await resolveExternalSessionObservationLinkInput({
                    linked,
                    sessionId: 'session-1',
                });
                expect(resolved).toMatchObject({
                    resource: {
                        pluginId: ANTIGRAVITY_PLUGIN_ID,
                        agentLocalId: ANTIGRAVITY_AGENT_ID,
                    },
                    link: {
                        sessionId: 'session-1',
                    },
                });
                if (!resolved) {
                    throw new Error('Expected Antigravity observation grouping');
                }
                const projection =
                    createExternalSessionObservationDaemonProjection({
                        publishField: vi.fn(async () => {}),
                        watchFile: vi.fn(() => () => {}),
                    });
                await expect(
                    projection.reconcileStatusLink(resolved),
                ).resolves.toMatchObject({
                    reconciliation: { state: 'reconciled' },
                });
                await projection.dispose();

                const runtime = runtimeRegistry.agentRuntimesByAgentId.get(
                    ANTIGRAVITY_AGENT_ID,
                );
                if (!runtime?.externalSessionObservation) {
                    throw new Error(
                        'Expected Antigravity observation contribution',
                    );
                }
                const observation = runtime.externalSessionObservation;
                const outsideObservation = {
                    ...observation,
                    async reconcileResource(request: Parameters<
                        typeof observation.reconcileResource
                    >[0]) {
                        if (request.purpose !== 'resource_descriptors') {
                            return await observation.reconcileResource(request);
                        }
                        return {
                            purpose: request.purpose,
                            outcomes: request.links.map(({ linkKey }) => ({
                                kind: 'described' as const,
                                descriptor: {
                                    resourceKey: request.resourceKey,
                                    linkKey,
                                    changeObservation:
                                        'watch_file_changes' as const,
                                    watchFileChanges: {
                                        files: [outsidePath],
                                    },
                                },
                            })),
                        };
                    },
                } satisfies typeof observation;

                const outsideProjection =
                    createExternalSessionObservationDaemonProjection({
                        acquireObservationContribution: async () => ({
                            contribution: outsideObservation,
                            filesystemReadAllowedPaths: new Set(['']),
                            release: async () => {},
                        }),
                        publishField: vi.fn(async () => {}),
                        watchFile: vi.fn(() => () => {}),
                    });
                await expect(
                    outsideProjection.reconcileStatusLink(resolved),
                ).rejects.toThrow('unauthorized file set');
                await outsideProjection.dispose();
            } finally {
                await runtimeRegistry?.dispose();
                envScope.restore();
            }
        });
    });
});
