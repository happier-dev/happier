import { describe, expect, it, vi } from 'vitest';

import type {
    AgentState,
    Metadata,
    Usage,
} from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import {
    applyAcpPostSendReactions,
    applyClaudePostSendReactions,
    applyCodexPostSendReactions,
} from './postSendReactions';

function createReactionPort(overrides?: Partial<Metadata>) {
    let metadata: Metadata = createTestMetadata(overrides);
    let agentState: AgentState = {};
    const publish = vi.fn().mockResolvedValue(undefined);

    return {
        port: {
            sessionId: 'session-1',
            updateMetadata: (updater: (current: Metadata) => Metadata) => {
                metadata = updater(metadata);
            },
            updateAgentState: (updater: (current: AgentState) => AgentState) => {
                agentState = updater(agentState);
            },
            getMetadataSnapshot: () => metadata,
            usageObservationPublisher: { publish },
        },
        getMetadata: () => metadata,
        getAgentState: () => agentState,
        publish,
    };
}

describe('postSendReactions', () => {
    it('publishes Claude assistant usage and mirrors summary metadata', () => {
        const { port, getMetadata, publish } = createReactionPort();
        const usage: Usage = {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2,
        };

        applyClaudePostSendReactions(port, {
            usage: { usage, model: 'claude-sonnet' },
            summary: { text: 'fresh summary', updatedAt: 123 },
        });

        expect(publish).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'session-1',
                observation: expect.objectContaining({
                    provider: 'claude',
                    modelId: 'claude-sonnet',
                }),
            }),
        );
        expect(getMetadata().summary).toEqual({
            text: 'fresh summary',
            updatedAt: 123,
        });
    });

    it('mirrors ACP permission requests into agent state', () => {
        const { port, getAgentState, publish } = createReactionPort();

        applyAcpPostSendReactions(port, {
            provider: 'claude',
            normalizedBody: {
                type: 'permission-request',
                permissionId: 'perm-1',
                toolName: 'write',
                description: 'write',
                options: {
                    input: {
                        filepath: '/tmp/outside.txt',
                    },
                },
            },
            localId: 'local-1',
        });

        expect(getAgentState().requests?.['perm-1']).toMatchObject({
            tool: 'write',
            source: 'claude',
            arguments: {
                input: {
                    filepath: '/tmp/outside.txt',
                },
            },
        });
        expect(publish).not.toHaveBeenCalled();
    });

    it('publishes ACP token_count usage with backend mode and derived external key', async () => {
        const { port, publish } = createReactionPort({ opencodeBackendMode: 'server' });

        applyAcpPostSendReactions(port, {
            provider: 'opencode',
            normalizedBody: {
                type: 'token_count',
                tokens: { total: 9, input: 4, output: 5 },
                key: 'opencode-message:1',
                source: 'opencode-message-updated',
                scope: 'turn_delta',
            },
            localId: 'local-1',
        });

        await vi.waitFor(() => {
            expect(publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: 'session-1',
                    backendMode: 'server',
                    externalKey: 'opencode-message:1',
                    observation: expect.objectContaining({
                        provider: 'opencode',
                    }),
                }),
            );
        });
    });

    it('publishes Codex token_count usage with forwarded backend mode and external key', async () => {
        const { port, publish } = createReactionPort();

        applyCodexPostSendReactions(port, {
            normalizedBody: {
                type: 'token_count',
                id: 'codex-token-1',
                tokens: { total: 9, input: 4, output: 5 },
                source: 'codex-app-server-token-usage',
                scope: 'session_cumulative',
            },
            backendMode: 'appServer',
            externalKey: 'codex-token-1',
        });

        await vi.waitFor(() => {
            expect(publish).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: 'session-1',
                    backendMode: 'appServer',
                    externalKey: 'codex-token-1',
                    observation: expect.objectContaining({
                        provider: 'codex',
                    }),
                }),
            );
        });
    });
});
