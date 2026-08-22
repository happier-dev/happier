import { describe, expect, it, vi } from 'vitest';
import { isPluginError } from '@happier-dev/plugin-sdk';

import { PluginTerminalHostError } from '@/plugins/runtime/context/terminalHost';
import { createNativeAgentSessionHostServices } from './nativeAgentSession';

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

    it('reserves an exact provider-fact identity through the canonical durable writer', async () => {
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
            sessionId: 'session-source-fact',
            directory: '/tmp/session-source-fact',
            signal: new AbortController().signal,
            isCurrent: () => true,
            session: {
                sessionId: 'session-source-fact',
                updateMetadata: vi.fn(),
                enqueueAgentMessageCommitted,
            },
            publications: {
                models: { bind: () => ({ dispose() {} }) },
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
        })).resolves.toEqual({ status: 'custodied' });

        expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
            'claude',
            {
                type: 'output',
                data: {
                    type: 'progress',
                    marker: 'source_fact_consumed',
                    reason: 'host_prompt_echo',
                },
            },
            {
                localId: 'claude-jsonl:main:user:user-1',
                meta: {
                    happier: { kind: 'source_fact_consumed.v1' },
                },
                provenance: { kind: 'non_dependent', source: 'external' },
            },
        );
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
