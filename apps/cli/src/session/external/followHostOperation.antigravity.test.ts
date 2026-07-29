import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
    buildLinkedExternalSessionQualifiedIdentityV1,
} from '@happier-dev/protocol';
import type {
    AgentExternalSessionObservationContribution,
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createExternalSessionFollowLeaseManager,
} from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import {
    createExternalSessionObservationDaemonProjection,
} from '@/api/session/external/leases/createExternalSessionObservationDaemonProjection';
import { createHostTerminalTranscriptFollowService } from '@/agent/runtime/session/terminal/transcriptFollow';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import type {
    HostExternalTranscriptFollowEvent,
} from '@/session/external/privateContract';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';

const mocks = vi.hoisted(() => ({
    loadLinkedExternalSession: vi.fn(),
    readCredentials: vi.fn(),
    resolveExternalSessionObservationLinkInput: vi.fn(),
    resolveGenerationBoundExternalSessionFollowSurface: vi.fn(),
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
    loadLinkedExternalSession: mocks.loadLinkedExternalSession,
}));
vi.mock('@/persistence', () => ({
    readCredentials: mocks.readCredentials,
}));
vi.mock('@/api/session/external/leases/resolveExternalSessionObservationLinkInput', () => ({
    resolveExternalSessionObservationLinkInput:
        mocks.resolveExternalSessionObservationLinkInput,
}));
vi.mock('@/session/actions/externalSessions/providerOpsResolution', () => ({
    resolveGenerationBoundExternalSessionFollowSurface:
        mocks.resolveGenerationBoundExternalSessionFollowSurface,
}));

import { createExternalSessionFollowHostOperation } from './followHostOperation';

function invocation() {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 30_000,
        maxSerializedBytes: 524_288,
    };
}

async function loadAntigravityFactories() {
    const externalSessionsPath =
        '../../../../../packages/plugins/antigravity/src/agent/cliPrint/externalSessions.js';
    const observationPath =
        '../../../../../packages/plugins/antigravity/src/agent/cliPrint/observation.js';
    const [externalSessionsModule, observationModule] = await Promise.all([
        import(externalSessionsPath),
        import(observationPath),
    ]);
    return {
        createExternalSessions:
            externalSessionsModule.createAntigravityExternalSessionsContribution as (
                params: Readonly<{ env: NodeJS.ProcessEnv }>,
            ) => AgentExternalSessionsContribution,
        createObservation:
            observationModule.createAntigravityExternalSessionObservationContribution as (
                params: Readonly<{ env: NodeJS.ProcessEnv }>,
            ) => AgentExternalSessionObservationContribution,
    };
}

describe('Antigravity External Session follow host operation', () => {
    const roots: string[] = [];

    afterEach(async () => {
        vi.clearAllMocks();
        await Promise.all(
            roots.splice(0).map(async (root) =>
                await rm(root, { recursive: true, force: true })),
        );
    });

    it('delivers an exact append, reports source loss/replacement, and retires the host listener', async () => {
        const root = await mkdtemp(join(
            tmpdir(),
            'happier-antigravity-follow-host-operation-',
        ));
        roots.push(root);
        const conversationId = 'conversation-host-operation-follow';
        const transcriptPath = join(
            root,
            '.gemini',
            'antigravity-cli',
            'brain',
            conversationId,
            '.system_generated',
            'logs',
            'transcript_full.jsonl',
        );
        await mkdir(dirname(transcriptPath), { recursive: true });
        await writeFile(transcriptPath, [
            JSON.stringify({
                id: 'initial-agent',
                type: 'PLANNER_RESPONSE',
                text: 'initial answer',
                conversationId,
                created_at: '2026-07-28T18:00:00Z',
            }),
            '',
        ].join('\n'), 'utf8');

        const env = { HOME: root };
        const { createExternalSessions, createObservation } =
            await loadAntigravityFactories();
        const externalSessions = createExternalSessions({ env });
        const observationContribution = createObservation({ env });
        const resolvedIdentity = await externalSessions.resolveLinkIdentity({
            ...invocation(),
            source: { kind: 'antigravityCliPrint' },
            remoteSessionId: conversationId,
        });
        if (!resolvedIdentity.ok) {
            throw new Error('Expected an authoritative Antigravity identity');
        }
        const linkedSource = resolvedIdentity.value;
        const grouping = observationContribution.describeResource(linkedSource);
        const pluginGeneration = 'antigravity-plugin-generation';
        const linkGeneration = 'antigravity-link-generation';
        const sessionId = 'antigravity-host-session';
        const qualifiedLinkIdentity =
            buildLinkedExternalSessionQualifiedIdentityV1({
                agent: {
                    pluginId: 'happier.agent.antigravity',
                    localId: 'antigravity',
                },
                sourceKind: 'antigravityCliPrint',
            });
        const observation = {
            resource: {
                pluginId: qualifiedLinkIdentity.agent.pluginId,
                agentLocalId: qualifiedLinkIdentity.agent.localId,
                pluginGeneration,
                resourceKey: grouping.resourceKey,
            },
            link: {
                sessionId,
                linkGeneration,
                linkKey: grouping.linkKey,
                linkedSource,
            },
            target: {
                qualifiedLinkIdentity,
                linkGeneration,
            },
        } as const;
        const resource = {
            linkGeneration,
            pluginGeneration,
        } as const;
        const linkedSession = {
            agentId: 'antigravity',
            linkGeneration,
            machineId: 'machine-1',
            metadata: {},
            remoteSessionId: conversationId,
            source: linkedSource.source,
            rawSession: null,
        } as const;

        mocks.readCredentials.mockResolvedValue({ token: 'token' });
        mocks.loadLinkedExternalSession.mockResolvedValue({
            ok: true,
            session: linkedSession,
        });
        mocks.resolveExternalSessionObservationLinkInput.mockResolvedValue(
            observation,
        );
        mocks.resolveGenerationBoundExternalSessionFollowSurface
            .mockResolvedValue({
                resource,
                providerOps: {
                    pageTranscript: async (request: Readonly<{
                        source: typeof linkedSource.source;
                        remoteSessionId: string;
                        direction: 'older' | 'newer';
                        cursor?: string;
                        maxBytes: number;
                        maxItems: number;
                        signal?: AbortSignal;
                    }>) => {
                        const result = await externalSessions.pageTranscript({
                            ...invocation(),
                            ...request,
                            maxSerializedBytes: request.maxBytes,
                            signal: request.signal
                                ?? new AbortController().signal,
                        });
                        if (!result.ok) {
                            throw new Error(result.code);
                        }
                        return result.value;
                    },
                    readAfterTranscript: async (request: Readonly<{
                        source: typeof linkedSource.source;
                        remoteSessionId: string;
                        cursor: string;
                        maxBytes: number;
                        maxItems: number;
                        signal?: AbortSignal;
                    }>) => {
                        const result =
                            await externalSessions.readAfterTranscript({
                                ...invocation(),
                                ...request,
                                maxSerializedBytes: request.maxBytes,
                                signal: request.signal
                                    ?? new AbortController().signal,
                            });
                        if (!result.ok) {
                            throw new Error(result.code);
                        }
                        return result.value;
                    },
                },
            });

        const writeFollowStatus = vi.fn(async () => {});
        const followLeaseManager =
            createExternalSessionFollowLeaseManager({
                writeFollowStatus,
            });
        const observationProjection =
            createExternalSessionObservationDaemonProjection({
                acquireObservationContribution: async () => ({
                    contribution: observationContribution,
                    filesystemReadAllowedPaths: new Set(['']),
                    release: async () => {},
                }),
                publishField: async () => {},
                requestTranscriptRefresh: async (input) =>
                    await followLeaseManager.requestTranscriptRefresh(input),
                isTranscriptRefreshDemanded: (input) =>
                    followLeaseManager.hasTranscriptDemand(input),
            });
        const operation = createExternalSessionFollowHostOperation({
            machineId: 'machine-1',
            followLeaseManager,
            observationProjection,
        });
        const retirement = new AbortController();
        const terminalLifecycle = new AbortController();
        const initialPage = await externalSessions.pageTranscript({
            ...invocation(),
            source: linkedSource.source,
            remoteSessionId: conversationId,
            direction: 'older',
            maxItems: 200,
        });
        if (!initialPage.ok || !initialPage.value.tailCursor) {
            throw new Error('Expected an accepted Antigravity history cursor');
        }
        const acceptedHistoryCursor = initialPage.value.tailCursor;
        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: true,
        }));
        const transcriptSession = {
            sessionId,
            sendUserTextMessage: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => undefined),
            enqueueAgentMessageCommitted,
        };
        const projectFollowEvent = createExternalSessionTerminalFollowProjector({
            sessionId,
            agentId: 'antigravity',
            projectRuntimeEvent: async (event) =>
                await projectRuntimeTranscriptEvent({
                    session: transcriptSession,
                    provider: 'antigravity',
                    event,
                }),
        });
        const listener = vi.fn(
            async (event: HostExternalTranscriptFollowEvent) => {
                await projectFollowEvent(event);
            },
        );
        const terminalFollow =
            createHostTerminalTranscriptFollowService({
                followProviderSession: async (request, followListener) =>
                    await operation.execute({
                        pluginId: qualifiedLinkIdentity.agent.pluginId,
                        contributionId:
                            qualifiedLinkIdentity.agent.localId,
                        generationId: pluginGeneration,
                        sessionId,
                        machineId: 'machine-1',
                        ref: {
                            agentId: request.agentId,
                            sourceId: 'configured',
                            remoteSessionId: request.providerSessionId,
                        },
                        source: linkedSource.source,
                        options: {
                            ...(request.cursor
                                ? { cursor: request.cursor }
                                : {}),
                            signal: request.signal,
                        },
                        listener: followListener,
                        retirementSignal: retirement.signal,
                        isCurrent: () => !retirement.signal.aborted,
                    }),
                signal: terminalLifecycle.signal,
                publish: listener,
            });

        try {
            const result = await terminalFollow.bindProviderSession({
                agentId: 'antigravity',
                providerSessionId: conversationId,
                cursor: acceptedHistoryCursor,
            });
            expect(result).toMatchObject({
                status: 'following',
                startingCursor: acceptedHistoryCursor,
            });
            expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();

            const marker = 'ANTIGRAVITY_HOST_OPERATION_FOLLOW_MARKER';
            await appendFile(transcriptPath, [
                JSON.stringify({
                    id: 'terminal-user-echo',
                    type: 'USER_INPUT',
                    text: 'terminal prompt already owned by the host',
                    conversationId,
                    created_at: '2026-07-28T18:00:01Z',
                }),
                JSON.stringify({
                    id: 'terminal-agent',
                    type: 'PLANNER_RESPONSE',
                    text: marker,
                    conversationId,
                    created_at: '2026-07-28T18:00:02Z',
                }),
                '',
            ].join('\n'), 'utf8');

            await vi.waitFor(() => {
                expect(listener).toHaveBeenCalledWith(
                    expect.objectContaining({
                        kind: 'data',
                        fromCursor: acceptedHistoryCursor,
                        items: expect.arrayContaining([
                            expect.objectContaining({
                                kind: 'agent',
                                data: { type: 'text', text: marker },
                            }),
                        ]),
                    }),
                );
            }, { timeout: 10_000 });
            await vi.waitFor(() => {
                expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
                    'antigravity',
                    { type: 'message', message: marker },
                    {
                        localId: 'terminal-agent',
                        provenance: {
                            kind: 'non_dependent',
                            source: 'external',
                        },
                    },
                );
            }, { timeout: 10_000 });
            await followLeaseManager.requestTranscriptRefresh({
                sessionId,
                resource,
            });
            expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(1);
            expect(transcriptSession.sendUserTextMessage)
                .not.toHaveBeenCalled();
            expect(transcriptSession.sendAgentMessageCommitted)
                .not.toHaveBeenCalled();

            await rm(transcriptPath);
            await followLeaseManager.requestTranscriptRefresh({
                sessionId,
                resource,
            });
            expect(writeFollowStatus).toHaveBeenLastCalledWith({
                sessionId,
                followStatusV1: expect.objectContaining({
                    status: 'error',
                    reason: 'follow_refresh_source_unavailable',
                }),
                lastFollowIssueV1: expect.objectContaining({
                    code: 'follow_refresh_source_unavailable',
                    retryable: true,
                }),
            });

            const replacementMarker =
                'ANTIGRAVITY_REPLACEMENT_MUST_NOT_BE_DELIVERED';
            await writeFile(transcriptPath, `${JSON.stringify({
                id: 'replacement-agent',
                type: 'PLANNER_RESPONSE',
                text: replacementMarker,
                conversationId,
                created_at: '2026-07-28T18:00:02Z',
            })}\n`, 'utf8');
            await followLeaseManager.requestTranscriptRefresh({
                sessionId,
                resource,
            });
            expect(writeFollowStatus).toHaveBeenLastCalledWith({
                sessionId,
                followStatusV1: expect.objectContaining({
                    status: 'error',
                    reason: 'follow_refresh_source_replaced',
                }),
                lastFollowIssueV1: expect.objectContaining({
                    code: 'follow_refresh_source_replaced',
                    retryable: true,
                }),
            });
            expect(listener).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: 'data',
                    items: expect.arrayContaining([
                        expect.objectContaining({
                            data: { type: 'text', text: replacementMarker },
                        }),
                    ]),
                }),
            );

            await followLeaseManager.suspendSession({
                sessionId,
                reason: 'takeover',
            });
            const takeoverOwnedMarker =
                'ANTIGRAVITY_TAKEOVER_OWNED_MUST_NOT_BE_DELIVERED';
            await appendFile(transcriptPath, `${JSON.stringify({
                id: 'takeover-owned-agent',
                type: 'PLANNER_RESPONSE',
                text: takeoverOwnedMarker,
                conversationId,
                created_at: '2026-07-28T18:00:03Z',
            })}\n`, 'utf8');
            await expect(followLeaseManager.requestTranscriptRefresh({
                sessionId,
                resource,
            })).resolves.toEqual({
                requested: false,
                reason: 'not-demanded',
            });
            expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(1);
            expect(listener).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: 'data',
                    items: expect.arrayContaining([
                        expect.objectContaining({
                            data: {
                                type: 'text',
                                text: takeoverOwnedMarker,
                            },
                        }),
                    ]),
                }),
            );

            retirement.abort();
            await vi.waitFor(() => {
                expect(listener).toHaveBeenCalledWith({
                    kind: 'terminated',
                    reason: 'retired',
                    cursor: expect.any(String),
                    code: 'plugin_generation_retired',
                });
            });
            if (result.status === 'following') {
                await result.binding.dispose();
                await result.binding.dispose();
            }
            expect(listener.mock.calls.filter(
                ([event]) => event.kind === 'terminated',
            )).toHaveLength(1);
        } finally {
            await observationProjection.dispose();
            await followLeaseManager.dispose();
        }
    }, 20_000);
});
