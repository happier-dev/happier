import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { shouldEnableExecutionRunPolling } from './shouldEnableExecutionRunPolling';

describe('shouldEnableExecutionRunPolling', () => {
    it('returns true when execution runs feature is enabled', () => {
        const result = shouldEnableExecutionRunPolling({
            executionRunsFeatureEnabled: true,
            messages: [],
        });

        expect(result).toBe(true);
    });

    it('returns true when feature is disabled but transcript contains SubAgentRun tool calls', () => {
        const messages: Message[] = [
            {
                kind: 'tool-call',
                id: 'm1',
                localId: null,
                createdAt: Date.now(),
                tool: {
                    name: 'SubAgentRun',
                    state: 'error',
                    input: { runId: 'run_1' },
                    createdAt: Date.now(),
                    startedAt: Date.now(),
                    completedAt: Date.now(),
                    description: null,
                    result: { error: 'Request interrupted' },
                },
                children: [],
            } as Message,
        ];

        const result = shouldEnableExecutionRunPolling({
            executionRunsFeatureEnabled: false,
            messages,
        });

        expect(result).toBe(true);
    });

    it('returns true when feature is disabled but transcript contains SubAgent transcript tool calls', () => {
        const messages: Message[] = [
            {
                kind: 'tool-call',
                id: 'm1',
                localId: null,
                createdAt: Date.now(),
                tool: {
                    name: 'SubAgent',
                    state: 'error',
                    input: { runId: 'run_1' },
                    createdAt: Date.now(),
                    startedAt: Date.now(),
                    completedAt: Date.now(),
                    description: null,
                    result: { error: 'Request interrupted' },
                },
                children: [],
            } as Message,
        ];

        const result = shouldEnableExecutionRunPolling({
            executionRunsFeatureEnabled: false,
            messages,
        });

        expect(result).toBe(true);
    });

    it('returns false when feature is disabled and transcript has no execution-run signals', () => {
        const messages: Message[] = [
            {
                kind: 'agent-text',
                id: 'm2',
                localId: null,
                createdAt: Date.now(),
                text: 'regular assistant message',
            } as Message,
        ];

        const result = shouldEnableExecutionRunPolling({
            executionRunsFeatureEnabled: false,
            messages,
        });

        expect(result).toBe(false);
    });
});
