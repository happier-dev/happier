import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createClaudeNativeAgentSdkContext } from '../../../../../../../packages/plugins/claude/src/agent/runtime/nativeServices';

import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionScopedSocketConnection } from '@/api/session/sockets';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createSessionTranscriptHomeStub, createSessionRuntimeActivityHomeStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import { PluginTerminalHostError } from '@/plugins/runtime/context/terminalHost';
import { resolveBackendEngineAdapterResolution } from '../engineRegistry';
import { createNativeAgentSessionHostServiceOwners } from './nativeAgentSessionHostServiceOwners';
import { createNativeAgentSessionPublications } from './nativeAgentSessionPublications';
import { createNativeAgentSessionWorkStateService } from './nativeAgentSessionWorkState';
import { composeNativeAgentSessionRuntimeContext, createNativeAgentSessionHostServices } from './nativeAgentSession';
import { createExecutionRunTranscriptProjection } from '@/agent/runtime/bridges/executionRun/messages/sessionStateEmission';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import { getSessionCommittedTranscriptLocalIds, shareSessionCommittedTranscriptLocalIds } from '@/api/session/client/transcript/committedTranscriptLocalIdBaseline';
import { createHostTerminalTranscriptFollowService } from '@/agent/runtime/session/terminal/transcriptFollow';
import { createExternalSessionTerminalFollowProjector } from '@/session/external/terminalFollowProjection';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';

// Home Socket.IO is the transport boundary; Session custody and runtime owners remain real.
vi.mock('socket.io-client', () => ({ io: () => {
    const home = createSessionTranscriptHomeStub();
    const activityHome = createSessionRuntimeActivityHomeStub({ machineId: 'native-transcript-machine' });
    return createApiSessionSocketStub({
        connected: true,
        emit: (event, args) => {
            if (event === 'ping' && typeof args[0] === 'function') args[0]();
        },
        emitWithAck: (event, payload) => home.answer(event, payload)
            ?? activityHome.answer(event, payload) ?? resolveApiSessionSocketDefaultAck(event, payload),
    });
} }));

describe('native Agent durable transcript publication', () => {
    it('projects a typed Session event through the canonical durable runtime transcript owner', async () => {
        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: false,
        }));
        const services = createNativeAgentSessionHostServices({
            owners: {
                features: { isEnabled: () => false },
                sessionHooks: {},
                transcripts: { fileFollow: {} },
                accountUsage: {},
                mcp: {},
                toolExecution: {},
            },
            agentId: 'claude',
            sessionId: 'session-durable-event',
            directory: '/tmp/session-durable-event',
            signal: new AbortController().signal,
            isCurrent: () => true,
            session: {
                sessionId: 'session-durable-event',
                updateMetadata: vi.fn(),
                enqueueAgentMessageCommitted,
            },
            publications: {
                models: { bind: () => ({ dispose() {} }) },
                modes: { bind: () => ({ dispose() {} }) },
                activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
            },
            readToolExecutionCapability: () => null,
        } as never);
        const event = {
            type: 'runtime-config-outcome' as const,
            agentId: 'claude',
            runtime: 'claude-unified-terminal',
            status: 'applied' as const,
            message: 'Applied Claude Unified runtime controls: model → sonnet.',
            changes: [{ key: 'model' as const, requested: 'sonnet', effective: 'sonnet' }],
        };

        await expect(
            services.transcripts.publishSessionEvent(event),
        ).resolves.toEqual({ status: 'custodied' });

        expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
            'claude',
            {
                type: 'event',
                data: event,
                id: expect.any(String),
            },
            expect.objectContaining({
                localId: expect.any(String),
                provenance: { kind: 'non_dependent', source: 'external' },
            }),
        );
    });

    it.each([null, 'child-sidechain'])('custodies exact Claude prompt echoes in scope %s through the native adapter and rejects a retired occurrence', async (sidechainId) => {
        const fixture = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { pluginIds: ['happier.agent.claude'] },
        });
        const signal = new AbortController().signal;
        const sessionId = sidechainId ? 'session-source-fact-child' : 'session-source-fact';
        const token = 'native-transcript-test-token';
        const serverUrl = 'https://native-transcript.example.test';
        const nativeFetch = globalThis.fetch;
        const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { session: {
            runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 }, publisherAuthority: { protocolVersion: 1 },
        } } });
        const homeHttp = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            if (url.origin === serverUrl && url.pathname === '/v1/features') return Response.json(features);
            return nativeFetch(input, init);
        });
        const homeAuth = vi.spyOn(axios, 'get').mockImplementation(async input => {
            const url = new URL(String(input));
            if (url.origin === serverUrl && url.pathname === '/v1/auth/ping') return { status: 200, data: {} };
            throw new Error(`Unexpected transcript Home HTTP boundary: ${url.pathname}`);
        });
        let session: ApiSessionClient | undefined;
        let owners: ReturnType<typeof createNativeAgentSessionHostServiceOwners> | undefined;
        let publications: ReturnType<typeof createNativeAgentSessionPublications> | undefined;
        try {
            session = new ApiSessionClient(token, createPlainSessionFixture({ id: sessionId }), {
                localMachineId: 'native-transcript-machine',
                metadataAuthority: { kind: 'shared_editor' },
                transport: {
                    serverId: 'native-transcript-home', serverUrl,
                    createSessionSocketTransport: ({ sessionId, machineId }) => createSessionScopedSocketConnection({
                        token, sessionId, machineId, serverUrl,
                    }),
                },
            });
            const enqueue = vi.spyOn(session, 'enqueueAgentMessageCommitted');
            const resolution = await resolveBackendEngineAdapterResolution('claude', { runtimeRegistry: fixture.registry });
            const lease = fixture.registry.agentRuntimesByAgentId.get('claude');
            if (!resolution || !lease) throw new Error('Expected admitted Claude runtime');
            const directory = fixture.happyHomeDir;
            const services = await fixture.registry.createAgentInvocationServices({
                pluginId: lease.pluginId, pluginVersion: lease.pluginVersion,
                agentId: 'claude', occurrenceId: lease.occurrenceId,
                correlationId: sessionId, cwd: directory, signal, isOccurrenceCurrent: lease.isCurrent,
            });
            owners = createNativeAgentSessionHostServiceOwners({
                runtimeRegistry: fixture.registry,
                identity: {
                    pluginId: lease.pluginId, agentId: 'claude', pluginVersion: lease.pluginVersion,
                    occurrenceId: lease.occurrenceId, isCurrent: lease.isCurrent,
                },
                backend: resolution.backend, agent: resolution.agent,
                hostSession: {
                    session, machineId: 'native-transcript-machine', accountSettingsAuthority: 'session',
                    permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: 'Native transcript fixture' }),
                },
                sessionId, directory, signal, happyHomeDir: fixture.happyHomeDir,
            });
            publications = createNativeAgentSessionPublications({
                agentId: 'claude', session, signal, isCurrent: lease.isCurrent, supportsInFlightSteer: false,
            });
            const controller: ExecutionRunBackendController = {
                kind: 'backend', controllerOccurrenceId: 'child-custody', backend: createTestExecutionRunHostRuntime(),
                backendSupportsResume: false, runtimeId: 'native-child', buffer: '', sidechainStreamBuffer: '',
                sidechainStreamKey: '', streamWriter: null, cancelled: false, turnCount: 0, turnEpoch: 0,
                turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null, admittedLiveInterventions: [],
                admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
                terminalPromise: Promise.resolve(), resolveTerminal() {}, pendingInputAcceptance: Promise.resolve('accepted'),
            };
            const transcriptSession = sidechainId ? (() => {
                const projection = createExecutionRunTranscriptProjection({ controller, sidechainId, isCurrent: lease.isCurrent, session });
                if (!projection.enqueueAgentMessageCommitted) throw new Error('Expected child transcript enqueue boundary');
                return { sessionId, updateMetadata: session.updateMetadata.bind(session), ...projection,
                    enqueueAgentMessageCommitted: projection.enqueueAgentMessageCommitted };
            })() : session;
            shareSessionCommittedTranscriptLocalIds(transcriptSession, session);
            const sessionServices = createNativeAgentSessionHostServices({
                owners, agentId: 'claude', sessionId, directory, signal, isCurrent: lease.isCurrent,
                session: transcriptSession, publications: publications.services, readToolExecutionCapability: () => null,
            });
            const context = composeNativeAgentSessionRuntimeContext({
                identity: { pluginId: lease.pluginId, pluginVersion: lease.pluginVersion, agentId: 'claude' },
                contributionId: 'claude',
                invokedAtMs: 0,
                sessionId,
                signal,
                sessionServices, services,
                ui: createPluginInvocationPresentation({ currentSession: null, signal, isOccurrenceCurrent: lease.isCurrent }),
                protocols: createPublicAcpRuntimeProtocols({
                    pluginId: lease.pluginId, agentId: 'claude', signal, isCurrent: lease.isCurrent,
                    services, models: sessionServices.models,
                }),
                workState: createNativeAgentSessionWorkStateService({
                    session, pluginId: lease.pluginId, contributionId: 'claude', agentId: 'claude',
                    occurrenceId: lease.occurrenceId, declarations: [], isCurrent: lease.isCurrent,
                }),
            });
            const transcripts = createClaudeNativeAgentSdkContext(context).agentRuntime.transcripts;
            const result = await transcripts.markSourceFactConsumed?.({
                localId: 'claude-jsonl:main:user:user-1',
                reason: 'host_prompt_echo',
            });

            const expectedRecord = [
                'claude',
                {
                    type: 'output',
                    data: {
                        type: 'progress',
                        marker: 'source_fact_consumed',
                        reason: 'host_prompt_echo',
                    },
                    ...(sidechainId ? { sidechainId } : {}),
                },
                {
                    localId: 'claude-jsonl:main:user:user-1',
                    meta: {
                        happier: { kind: 'source_fact_consumed.v1' },
                    },
                    provenance: { kind: 'non_dependent', source: 'external' },
                },
            ];
            expect(enqueue.mock.calls).toEqual([expectedRecord]);
            await expect(enqueue.mock.results[0]?.value).resolves.toMatchObject({ persisted: true });
            expect(result).toEqual({ status: 'custodied' });

            // A native source can catch up after the Home baseline was read but
            // after this host prompt acquired durable custody. Its user echo must
            // not overwrite the consumed marker with a different role/timestamp.
            const enqueueUser = vi.spyOn(session, 'enqueueUserTextMessageCommitted');
            const follow = createHostTerminalTranscriptFollowService({
                signal,
                loadCommittedLocalIdBaseline: async () => ({
                    localIds: getSessionCommittedTranscriptLocalIds(session!), complete: true,
                }),
                followProviderSession: async (_request, listener) => {
                    await listener({ kind: 'data', phase: 'initial_replay', fromCursor: null, nextCursor: 'tail', items: [
                        { kind: 'user', id: 'claude-jsonl:main:user:user-1', localId: 'claude-jsonl:main:user:user-1',
                            userProjection: 'source_fact', timestampMs: 200, data: { role: 'user', content: { type: 'text', text: 'Host-only prompt' } } },
                        { kind: 'agent', id: 'new-assistant', timestampMs: 201, data: { role: 'agent', content: { type: 'message', message: 'New output' } } },
                    ] });
                    return { status: 'following', startingCursor: 'tail', subscription: { dispose: async () => undefined } };
                },
                publish: createExternalSessionTerminalFollowProjector({
                    sessionId, agentId: 'claude',
                    projectRuntimeEvent: (event, admission, sourceReplayLocalId) => projectRuntimeTranscriptEvent({
                        session: transcriptSession, provider: 'claude', event, admission, sourceReplayLocalId,
                    }),
                }),
            });
            try {
                await expect(follow.bindProviderSession({ agentId: 'claude', providerSessionId: 'native-echo' }))
                    .resolves.toMatchObject({ status: 'following' });
                expect(enqueue.mock.calls).toEqual([expectedRecord, [
                    'claude',
                    { type: 'message', message: 'New output', ...(sidechainId ? { sidechainId } : {}) },
                    expect.objectContaining({ localId: 'new-assistant' }),
                ]]);
                expect(enqueueUser).not.toHaveBeenCalled();
            } finally {
                await follow.releaseActiveBindings();
            }

            await fixture.lease.release();
            await fixture.controller.shutdown();
            await expect(transcripts.markSourceFactConsumed?.({
                localId: 'claude-jsonl:main:user:user-2',
                reason: 'host_prompt_echo',
            })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
            expect(enqueue.mock.calls).toHaveLength(2);
            expect(enqueueUser).not.toHaveBeenCalled();
        } finally {
            try {
                publications?.dispose();
                try {
                    await owners?.dispose();
                } finally {
                    await session?.close();
                }
            } finally {
                try {
                    await fixture.dispose();
                } finally {
                    homeHttp.mockRestore();
                    homeAuth.mockRestore();
                }
            }
        }
    });

    it('does not bypass the exact durable session identity for a source fact', async () => {
        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: false,
        }));
        const services = createNativeAgentSessionHostServices({
            owners: {
                features: { isEnabled: () => false },
                sessionHooks: {},
                transcripts: { fileFollow: {} },
                accountUsage: {},
                mcp: {},
                toolExecution: {},
            },
            agentId: 'claude',
            sessionId: 'session-scope',
            directory: '/tmp/session-scope',
            signal: new AbortController().signal,
            isCurrent: () => true,
            session: {
                sessionId: 'session-durable',
                updateMetadata: vi.fn(),
                enqueueAgentMessageCommitted,
            },
            publications: {
                models: { bind: () => ({ dispose() {} }) },
                modes: { bind: () => ({ dispose() {} }) },
                activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
            },
            readToolExecutionCapability: () => null,
        } as never);

        const markSourceFactConsumed = services.transcripts.markSourceFactConsumed;
        expect(markSourceFactConsumed).toBeTypeOf('function');
        if (!markSourceFactConsumed) {
            throw new Error('Expected source-fact consumption support');
        }

        await expect(markSourceFactConsumed({
            localId: 'claude-jsonl:main:user:user-1',
            reason: 'host_prompt_echo',
        })).rejects.toThrow(
            'Transcript source-fact session scope does not match the durable session',
        );
        expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    });

    it('projects stable terminal and transcript failures through the public PluginError contract', async () => {
        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: false,
            delivered: false,
        }));
        const services = createNativeAgentSessionHostServices({
            owners: {
                features: { isEnabled: () => false },
                sessionHooks: {},
                transcripts: { fileFollow: {} },
                accountUsage: {},
                mcp: {},
                toolExecution: {},
            },
            agentId: 'claude',
            sessionId: 'session-public-errors',
            directory: '/tmp/session-public-errors',
            signal: new AbortController().signal,
            isCurrent: () => true,
            terminalHost: {
                async resolve() {
                    throw new PluginTerminalHostError(
                        'PLUGIN_TERMINAL_HOST_UNAVAILABLE',
                        'No terminal host is currently available',
                    );
                },
            } as never,
            session: {
                sessionId: 'session-public-errors',
                updateMetadata: vi.fn(),
                enqueueAgentMessageCommitted,
            },
            publications: {
                models: { bind: () => ({ dispose() {} }) },
                modes: { bind: () => ({ dispose() {} }) },
                activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
            },
            readToolExecutionCapability: () => null,
        } as never);

        const terminalHost = services.terminalHost;
        expect(terminalHost).toBeDefined();
        const terminalFailure = await terminalHost!
            .resolve({ preference: 'auto' })
            .catch((error: unknown) => error);
        expect(isPluginError(terminalFailure)).toBe(true);
        expect(terminalFailure).toMatchObject({
            code: 'PLUGIN_TERMINAL_HOST_UNAVAILABLE',
            retryable: false,
        });

        const transcriptFailure = await services.transcripts
            .publishSessionEvent({
                type: 'terminal-composer-draft-blocked',
                reason: 'idle_draft_guard',
                stateAtMs: 123,
                message: 'Clear the terminal draft.',
            })
            .catch((error: unknown) => error);
        expect(isPluginError(transcriptFailure)).toBe(true);
        expect(transcriptFailure).toMatchObject({
            code: 'runtime_transcript_required_admission_failed',
            retryable: false,
            details: {
                reason: 'durable_custody_rejected',
                eventKind: 'terminal-composer-draft-blocked',
            },
        });
    });

    it('keeps unexpected terminal failures as errors and terminal resolution as a typed result', async () => {
        const unexpected = new Error('terminal adapter invariant failed');
        const services = createNativeAgentSessionHostServices({
            owners: {
                features: { isEnabled: () => false },
                sessionHooks: {},
                transcripts: { fileFollow: {} },
                accountUsage: {},
                mcp: {},
                toolExecution: {},
            },
            agentId: 'claude',
            sessionId: 'session-terminal-result',
            directory: '/tmp/session-terminal-result',
            signal: new AbortController().signal,
            isCurrent: () => true,
            terminalHost: {
                async resolve(request: { preference: string }) {
                    if (request.preference === 'auto') {
                        return {
                            status: 'disabled' as const,
                            reason: 'no_host_available' as const,
                            message: 'No terminal host is configured',
                        };
                    }
                    throw unexpected;
                },
            } as never,
            session: {
                sessionId: 'session-terminal-result',
                updateMetadata: vi.fn(),
                enqueueAgentMessageCommitted: vi.fn(),
            },
            publications: {
                models: { bind: () => ({ dispose() {} }) },
                modes: { bind: () => ({ dispose() {} }) },
                activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
            },
            readToolExecutionCapability: () => null,
        } as never);

        const terminalHost = services.terminalHost;
        expect(terminalHost).toBeDefined();
        await expect(terminalHost!.resolve({ preference: 'auto' })).resolves.toEqual({
            status: 'disabled',
            reason: 'no_host_available',
            message: 'No terminal host is configured',
        });

        const terminalFailure = await terminalHost!
            .resolve({ preference: 'tmux' })
            .catch((error: unknown) => error);
        expect(terminalFailure).toBe(unexpected);
        expect(isPluginError(terminalFailure)).toBe(false);
    });

    it('projects host-service admission refusals through the canonical public PluginError contract', async () => {
        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: false,
        }));
        const services = createNativeAgentSessionHostServices({
            owners: {
                features: { isEnabled: () => false },
                sessionHooks: {},
                transcripts: { fileFollow: {} },
                accountUsage: {},
                mcp: {
                    resolveForSession: async () => [Object.freeze({
                        id: 'acme',
                        name: 'Acme',
                        transport: Object.freeze({ kind: 'acme-native' }),
                    })],
                },
                toolExecution: {},
            },
            agentId: 'claude',
            sessionId: 'session-abi-refusals',
            directory: '/tmp/session-abi-refusals',
            signal: new AbortController().signal,
            isCurrent: () => true,
            session: {
                sessionId: 'session-abi-refusals-durable',
                updateMetadata: vi.fn(),
                enqueueAgentMessageCommitted,
            },
            publications: {
                models: { bind: () => ({ dispose() {} }) },
                modes: { bind: () => ({ dispose() {} }) },
                activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
            },
            readToolExecutionCapability: () => null,
        } as never);

        const markSourceFactConsumed = services.transcripts.markSourceFactConsumed;
        if (!markSourceFactConsumed) throw new Error('Expected source-fact consumption support');

        const scopeMismatch = await markSourceFactConsumed({
            localId: 'claude-jsonl:main:user:user-1',
            reason: 'host_prompt_echo',
        }).catch((error: unknown) => error);
        expect(isPluginError(scopeMismatch)).toBe(true);
        expect(scopeMismatch).toMatchObject({
            code: 'native_agent_transcript_session_scope_mismatch',
            retryable: false,
        });
        expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();

        const mcpFailure = await services.mcp.resolveServers().catch((error: unknown) => error);
        expect(isPluginError(mcpFailure)).toBe(true);
        expect(mcpFailure).toMatchObject({
            code: 'native_agent_mcp_transport_unsupported',
            retryable: false,
        });
    });

    it('refuses an invalid transcript source-fact localId through the canonical PluginError contract', async () => {
        const enqueueAgentMessageCommitted = vi.fn(async () => ({
            persisted: true,
            delivered: false,
        }));
        const services = createNativeAgentSessionHostServices({
            owners: {
                features: { isEnabled: () => false },
                sessionHooks: {},
                transcripts: { fileFollow: {} },
                accountUsage: {},
                mcp: {},
                toolExecution: {},
            },
            agentId: 'claude',
            sessionId: 'session-local-id',
            directory: '/tmp/session-local-id',
            signal: new AbortController().signal,
            isCurrent: () => true,
            session: {
                sessionId: 'session-local-id',
                updateMetadata: vi.fn(),
                enqueueAgentMessageCommitted,
            },
            publications: {
                models: { bind: () => ({ dispose() {} }) },
                modes: { bind: () => ({ dispose() {} }) },
                activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
            },
            readToolExecutionCapability: () => null,
        } as never);

        const markSourceFactConsumed = services.transcripts.markSourceFactConsumed;
        if (!markSourceFactConsumed) throw new Error('Expected source-fact consumption support');

        const failure = await markSourceFactConsumed({
            localId: '  ',
            reason: 'host_prompt_echo',
        }).catch((error: unknown) => error);
        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: 'native_agent_transcript_source_fact_local_id_invalid',
            retryable: false,
        });
        expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    });
});
