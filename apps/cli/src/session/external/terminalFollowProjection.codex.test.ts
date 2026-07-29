import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { mapPluginExternalTranscriptItem } from './pluginExternalSessionsAdapter';
import { createExternalSessionTerminalFollowProjector } from './terminalFollowProjection';

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

function jsonl(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

async function loadCodexContribution(params: Readonly<{
    env: NodeJS.ProcessEnv;
    activeServerDir: string;
}>): Promise<AgentExternalSessionsContribution> {
    const contributionPath =
        '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution.js';
    const contributionModule = await import(contributionPath);
    const createContribution =
        contributionModule.createCodexExternalSessionsContribution as (
            options: typeof params,
        ) => AgentExternalSessionsContribution;
    return createContribution(params);
}

async function loadCodexObservation(
    env: NodeJS.ProcessEnv,
): Promise<AgentExternalSessionObservationContribution> {
    const observationPath =
        '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/observation.js';
    const observationModule = await import(observationPath);
    const createObservation =
        observationModule.createCodexExternalSessionObservationContribution as (
            options: Readonly<{ env: NodeJS.ProcessEnv }>,
        ) => AgentExternalSessionObservationContribution;
    return createObservation({ env });
}

describe('Codex terminal follow projection', () => {
    const roots: string[] = [];

    afterEach(async () => {
        vi.clearAllMocks();
        await Promise.all(
            roots.splice(0).map(async (root) =>
                await rm(root, { recursive: true, force: true })),
        );
    });

    it('projects only a post-cursor assistant append through the durable writer', async () => {
        const root = await mkdtemp(join(
            tmpdir(),
            'happier-codex-terminal-follow-projection-',
        ));
        roots.push(root);
        const codexHome = join(root, 'codex-home');
        const activeServerDir = join(root, 'active-server');
        const sessionsDir = join(codexHome, 'sessions', '2026', '07', '29');
        const remoteSessionId = '11111111-1111-1111-1111-111111111111';
        const rolloutPath = join(
            sessionsDir,
            `rollout-2026-07-29T08-00-00-${remoteSessionId}.jsonl`,
        );
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(rolloutPath, [
            jsonl({
                type: 'session_meta',
                timestamp: '2026-07-29T08:00:00.000Z',
                payload: {
                    id: remoteSessionId,
                    timestamp: '2026-07-29T08:00:00.000Z',
                    cwd: '/repo/codex-terminal-follow',
                },
            }),
            jsonl({
                type: 'response_item',
                timestamp: '2026-07-29T08:00:01.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'accepted private history',
                    }],
                },
            }),
        ].join(''), 'utf8');

        const contribution = await loadCodexContribution({
            env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
            activeServerDir,
        });
        const identity = await contribution.resolveLinkIdentity({
            ...invocation(),
            source: { kind: 'codexHome', home: 'user' },
            remoteSessionId,
        });
        if (!identity.ok) throw new Error(identity.code);
        const initial = await contribution.pageTranscript({
            ...invocation(),
            source: identity.value.source,
            remoteSessionId,
            direction: 'older',
            maxItems: 200,
        });
        if (!initial.ok || !initial.value.tailCursor) {
            throw new Error('Expected an accepted Codex tail cursor');
        }

        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: true,
        }));
        const session = {
            sessionId: 'hosted-codex-session',
            sendUserTextMessage: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => undefined),
            enqueueAgentMessageCommitted,
        };
        const project = createExternalSessionTerminalFollowProjector({
            sessionId: session.sessionId,
            agentId: 'codex',
            projectRuntimeEvent: async (event) =>
                await projectRuntimeTranscriptEvent({
                    session,
                    provider: 'codex',
                    event,
                }),
        });
        expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();

        const marker = 'CODEX_POST_CURSOR_TERMINAL_MARKER';
        await appendFile(rolloutPath, [
            jsonl({
                type: 'response_item',
                timestamp: '2026-07-29T08:00:02.000Z',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{
                        type: 'input_text',
                        text: 'terminal input already owned by the host',
                    }],
                },
            }),
            jsonl({
                type: 'response_item',
                timestamp: '2026-07-29T08:00:03.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: marker,
                    }],
                },
            }),
        ].join(''), 'utf8');
        const after = await contribution.readAfterTranscript({
            ...invocation(),
            source: identity.value.source,
            remoteSessionId,
            cursor: initial.value.tailCursor,
            maxItems: 200,
        });
        if (!after.ok || after.value.outcome !== 'advanced') {
            throw new Error('Expected a Codex transcript advance');
        }

        await project({
            kind: 'data',
            items: after.value.items.map(mapPluginExternalTranscriptItem),
            fromCursor: initial.value.tailCursor,
            nextCursor: after.value.nextCursor,
        });

        expect(enqueueAgentMessageCommitted).toHaveBeenCalledOnce();
        expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
            'codex',
            { type: 'message', message: marker },
            {
                localId: expect.stringContaining('codex:'),
                provenance: {
                    kind: 'non_dependent',
                    source: 'external',
                },
            },
        );
        expect(session.sendUserTextMessage).not.toHaveBeenCalled();
        expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    });

    it('excludes late rollout rows after takeover suspension while hosted output remains authoritative', async () => {
        const root = await mkdtemp(join(
            tmpdir(),
            'happier-codex-terminal-follow-authority-',
        ));
        roots.push(root);
        const codexHome = join(root, 'codex-home');
        const activeServerDir = join(root, 'active-server');
        const sessionsDir = join(codexHome, 'sessions', '2026', '07', '29');
        const remoteSessionId = '22222222-2222-2222-2222-222222222222';
        const rolloutPath = join(
            sessionsDir,
            `rollout-2026-07-29T09-00-00-${remoteSessionId}.jsonl`,
        );
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(rolloutPath, [
            jsonl({
                type: 'session_meta',
                timestamp: '2026-07-29T09:00:00.000Z',
                payload: {
                    id: remoteSessionId,
                    timestamp: '2026-07-29T09:00:00.000Z',
                    cwd: '/repo/codex-terminal-authority',
                },
            }),
            jsonl({
                type: 'response_item',
                timestamp: '2026-07-29T09:00:01.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: 'accepted private history',
                    }],
                },
            }),
        ].join(''), 'utf8');

        const env = { CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
        const contribution = await loadCodexContribution({
            env,
            activeServerDir,
        });
        const observationContribution = await loadCodexObservation(env);
        const identity = await contribution.resolveLinkIdentity({
            ...invocation(),
            source: { kind: 'codexHome', home: 'user' },
            remoteSessionId,
        });
        if (!identity.ok) throw new Error(identity.code);
        const linkedSource = identity.value;
        const grouping = observationContribution.describeResource(linkedSource);
        const sessionId = 'hosted-codex-authority-session';
        const linkGeneration = 'codex-link-generation';
        const pluginGeneration = 'codex-plugin-generation';
        const qualifiedLinkIdentity =
            buildLinkedExternalSessionQualifiedIdentityV1({
                agent: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
                sourceKind: 'codexHome',
            });
        const resource = {
            linkGeneration,
            pluginGeneration,
        } as const;
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
        const linkedSession = {
            agentId: 'codex',
            linkGeneration,
            machineId: 'machine-1',
            metadata: {},
            remoteSessionId,
            source: linkedSource.source,
            rawSession: null,
        } as const;
        const pageTranscript = async (request: Readonly<{
            source: typeof linkedSource.source;
            remoteSessionId: string;
            direction: 'older' | 'newer';
            cursor?: string;
            maxBytes: number;
            maxItems: number;
            signal?: AbortSignal;
        }>) => {
            const result = await contribution.pageTranscript({
                ...invocation(),
                ...request,
                maxSerializedBytes: request.maxBytes,
                signal: request.signal ?? new AbortController().signal,
            });
            if (!result.ok) throw new Error(result.code);
            return result.value;
        };
        const readAfterTranscript = async (request: Readonly<{
            source: typeof linkedSource.source;
            remoteSessionId: string;
            cursor: string;
            maxBytes: number;
            maxItems: number;
            signal?: AbortSignal;
        }>) => {
            const result = await contribution.readAfterTranscript({
                ...invocation(),
                ...request,
                maxSerializedBytes: request.maxBytes,
                signal: request.signal ?? new AbortController().signal,
            });
            if (!result.ok) throw new Error(result.code);
            return result.value;
        };

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
                    pageTranscript,
                    readAfterTranscript,
                },
            });

        const followLeaseManager =
            createExternalSessionFollowLeaseManager({
                writeFollowStatus: async () => {},
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
        const initial = await contribution.pageTranscript({
            ...invocation(),
            source: linkedSource.source,
            remoteSessionId,
            direction: 'older',
            maxItems: 200,
        });
        if (!initial.ok || !initial.value.tailCursor) {
            throw new Error('Expected an accepted Codex tail cursor');
        }

        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: true,
        }));
        const session = {
            sessionId,
            sendUserTextMessage: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => undefined),
            enqueueAgentMessageCommitted,
        };
        const project = createExternalSessionTerminalFollowProjector({
            sessionId,
            agentId: 'codex',
            projectRuntimeEvent: async (event) =>
                await projectRuntimeTranscriptEvent({
                    session,
                    provider: 'codex',
                    event,
                }),
        });
        const listener = vi.fn(
            async (event: HostExternalTranscriptFollowEvent) => {
                await project(event);
            },
        );
        const retirement = new AbortController();
        const terminalLifecycle = new AbortController();
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
                agentId: 'codex',
                providerSessionId: remoteSessionId,
                cursor: initial.value.tailCursor,
            });
            expect(result).toMatchObject({
                status: 'following',
                startingCursor: initial.value.tailCursor,
            });
            expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();

            const externalMarker = 'CODEX_LINKED_TERMINAL_MARKER';
            await appendFile(rolloutPath, jsonl({
                type: 'response_item',
                timestamp: '2026-07-29T09:00:02.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: externalMarker,
                    }],
                },
            }), 'utf8');
            await followLeaseManager.requestTranscriptRefresh({
                sessionId,
                resource,
            });
            expect(enqueueAgentMessageCommitted).toHaveBeenCalledOnce();
            expect(enqueueAgentMessageCommitted).toHaveBeenLastCalledWith(
                'codex',
                { type: 'message', message: externalMarker },
                {
                    localId: expect.stringContaining('codex:'),
                    provenance: {
                        kind: 'non_dependent',
                        source: 'external',
                    },
                },
            );
            await followLeaseManager.requestTranscriptRefresh({
                sessionId,
                resource,
            });
            expect(enqueueAgentMessageCommitted).toHaveBeenCalledOnce();

            await followLeaseManager.suspendSession({
                sessionId,
                reason: 'takeover',
            });
            const lateExternalMarker =
                'CODEX_LATE_EXTERNAL_AFTER_TAKEOVER_MUST_NOT_APPLY';
            await appendFile(rolloutPath, jsonl({
                type: 'response_item',
                timestamp: '2026-07-29T09:00:03.000Z',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{
                        type: 'output_text',
                        text: lateExternalMarker,
                    }],
                },
            }), 'utf8');
            await expect(followLeaseManager.requestTranscriptRefresh({
                sessionId,
                resource,
            })).resolves.toEqual({
                requested: false,
                reason: 'not-demanded',
            });
            expect(enqueueAgentMessageCommitted).toHaveBeenCalledOnce();

            const hostedMarker = 'CODEX_HOSTED_RUNTIME_MARKER';
            await projectRuntimeTranscriptEvent({
                session,
                provider: 'codex',
                event: {
                    kind: 'transcript-agent-message-committed',
                    sessionId,
                    emittedAtMs: Date.parse('2026-07-29T09:00:04.000Z'),
                    agentId: 'codex',
                    localId: 'hosted-runtime-marker',
                    body: {
                        type: 'message',
                        message: hostedMarker,
                    },
                },
            });
            expect(enqueueAgentMessageCommitted).toHaveBeenCalledTimes(2);
            expect(enqueueAgentMessageCommitted).toHaveBeenLastCalledWith(
                'codex',
                { type: 'message', message: hostedMarker },
                {
                    localId: 'hosted-runtime-marker',
                    provenance: {
                        kind: 'non_dependent',
                        source: 'external',
                    },
                },
            );
            expect(JSON.stringify(enqueueAgentMessageCommitted.mock.calls))
                .not.toContain(lateExternalMarker);

            retirement.abort();
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
