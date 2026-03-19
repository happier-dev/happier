import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
    const now = Date.now();
    return {
        name: 'UnknownTool',
        state: 'completed',
        input: {},
        result: null,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        description: null,
        permission: undefined,
        ...overrides,
    };
}

async function loadSubject() {
    const mod = await import('./resolveToolTranscriptSidechainId');
    return mod.resolveToolTranscriptSidechainId;
}

describe('resolveToolTranscriptSidechainId', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('prefers result.sidechainId for SubAgentRun tools', async () => {
        const resolveToolTranscriptSidechainId = await loadSubject();
        const tool = makeToolCall({
            id: 'tool_use_123',
            name: 'SubAgentRun',
            result: { sidechainId: 'sidechain_run_456' },
        });
        expect(resolveToolTranscriptSidechainId({ tool, normalizedToolName: 'SubAgentRun' })).toBe('sidechain_run_456');
    });

    it('prefers input.sidechainId for SubAgentRun tools when result.sidechainId missing', async () => {
        const resolveToolTranscriptSidechainId = await loadSubject();
        const tool = makeToolCall({
            name: 'SubAgentRun',
            input: { sidechainId: 'subagent_run_abc' },
            result: null,
        });
        expect(resolveToolTranscriptSidechainId({ tool, normalizedToolName: 'SubAgentRun' })).toBe('subagent_run_abc');
    });

    it('falls back to input.callId for SubAgentRun tools when input.sidechainId missing', async () => {
        const resolveToolTranscriptSidechainId = await loadSubject();
        const tool = makeToolCall({
            name: 'SubAgentRun',
            input: { callId: 'subagent_run_def' },
            result: null,
        });
        expect(resolveToolTranscriptSidechainId({ tool, normalizedToolName: 'SubAgentRun' })).toBe('subagent_run_def');
    });

    it('falls back to tool.id for SubAgentRun tools when result.sidechainId missing', async () => {
        const resolveToolTranscriptSidechainId = await loadSubject();
        const tool = makeToolCall({
            id: 'tool_use_123',
            name: 'SubAgentRun',
            result: {},
        });
        expect(resolveToolTranscriptSidechainId({ tool, normalizedToolName: 'SubAgentRun' })).toBe('tool_use_123');
    });

    it('keeps the tool_use id for Task tools even when teammate metadata is present', async () => {
        const resolveToolTranscriptSidechainId = await loadSubject();
        const tool = makeToolCall({
            id: 'tool_use_123',
            name: 'Task',
            result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'beta@qa_123' } },
        });
        expect(resolveToolTranscriptSidechainId({ tool, normalizedToolName: 'Task' })).toBe('tool_use_123');
    });

    it('keeps the tool_use id for Agent tools even when teammate metadata is present', async () => {
        const resolveToolTranscriptSidechainId = await loadSubject();
        const tool = makeToolCall({
            id: 'tool_use_789',
            name: 'Agent',
            result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@qa_123' } },
        });
        expect(resolveToolTranscriptSidechainId({ tool, normalizedToolName: 'Agent' })).toBe('tool_use_789');
    });

    it('falls back to tool.id for Task tools when no teammate id present', async () => {
        const resolveToolTranscriptSidechainId = await loadSubject();
        const tool = makeToolCall({
            id: 'tool_use_123',
            name: 'Task',
            result: { tool_use_result: { status: 'ok' } },
        });
        expect(resolveToolTranscriptSidechainId({ tool, normalizedToolName: 'Task' })).toBe('tool_use_123');
    });

    it('falls back to tool.id for SubAgent tools when no teammate id present', async () => {
        const resolveToolTranscriptSidechainId = await loadSubject();
        const tool = makeToolCall({
            id: 'tool_use_subagent_123',
            name: 'SubAgent',
            input: { prompt: 'inspect repo' },
            result: { status: 'ok' },
        });
        expect(resolveToolTranscriptSidechainId({ tool, normalizedToolName: 'SubAgent' })).toBe('tool_use_subagent_123');
    });
});
