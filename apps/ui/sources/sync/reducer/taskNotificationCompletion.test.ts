import { readFile } from 'node:fs/promises';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { isClaudeAsyncAgentLaunchToolResult } from '@happier-dev/protocol';
import { normalizeToolCallForRendering } from '@/components/tools/normalization/core/normalizeToolCallForRendering';
import { collectHostText, renderScreen } from '@/dev/testkit';

import { normalizeRawMessage } from '../typesRaw';
import type { Message, ToolCall } from '../domains/messages/messageTypes';
import { deriveSubAgentSidechainSubagents } from '../domains/session/subagents/subAgentSidechains/deriveSubAgentSidechainSubagents';
import { createReducer, reducer } from './reducer';

function fold(rows: readonly unknown[]) {
    const state = createReducer();
    const messages = new Map<string, Message>();
    rows.forEach((data, index) => {
        const raw = { role: 'agent', content: { type: 'output', data } };
        const normalized = normalizeRawMessage(`msg-${index}`, null, index + 1, raw as never, { seq: index + 1 });
        if (normalized) {
            for (const message of reducer(state, [normalized]).messages) messages.set(message.id, message);
        }
    });
    const tool = (toolId: string) => {
        const id = state.toolIdToMessageId.get(toolId);
        return id ? state.messages.get(id)?.tool : undefined;
    };
    return { tool, messages: [...messages.values()] };
}

async function renderFullTaskResult(tool: ToolCall) {
    const { SubAgentView } = await import('@/components/tools/renderers/workflow/SubAgentView');
    // ToolFullView uses this real renderer as its full-detail header when the child
    // transcript is empty, including the roster's native Task/Agent details route.
    const screen = await renderScreen(React.createElement(SubAgentView, {
        tool: normalizeToolCallForRendering(tool),
        metadata: null,
        messages: [],
        detailLevel: 'full',
    }));
    return collectHostText(screen.tree).join(' ');
}

const launch = { type: 'assistant', uuid: 'launch', message: { content: [
    { type: 'tool_use', id: 'tool', name: 'Agent', input: { run_in_background: true } },
] } };
const ack = { type: 'user', uuid: 'ack', toolUseResult: { status: 'async_launched', agentId: 'task' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Async agent launched successfully.' }] } };
const persistedCompletion = { type: 'user', uuid: 'completion', isMeta: true,
    origin: { kind: 'task-notification', taskId: 'task', toolUseId: 'tool', status: 'completed' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'text', text: 'final findings' }], is_error: false }] } };

describe('native task completion through normalization and reducer', () => {
    it('keeps a stopped child outcome separate from the SendMessage tool that reported it', () => {
        const send = { type: 'assistant', uuid: 'send', message: { content: [
            { type: 'tool_use', id: 'send-tool', name: 'SendMessage', input: { to: 'task', message: 'Continue' } },
        ] } };
        const stopped = { type: 'user', uuid: 'stopped', origin: {
            kind: 'task-notification', taskId: 'task', toolUseId: 'tool', status: 'stopped', result: 'Partial findings',
        }, message: { content: [
            { type: 'tool_result', tool_use_id: 'send-tool', is_error: false,
                content: { content: 'Agent was stopped', tool_use_result: { success: false, message: 'Agent was stopped' } } },
            { type: 'tool_result', tool_use_id: 'tool', is_error: true,
                content: { status: 'cancelled', result: 'Partial findings' } },
        ] } };
        const folded = fold([launch, ack, send, stopped]);
        expect(folded.tool('send-tool')?.state).toBe('completed');
        expect(folded.tool('tool')?.state).toBe('error');
        expect(JSON.stringify(folded.tool('tool')?.result)).toContain('Partial findings');
        expect(deriveSubAgentSidechainSubagents({ messages: folded.messages, flavor: 'claude' })[0]?.status).toBe('cancelled');
    });

    it('shows a delivered subagent hand-back report on its background Agent card', async () => {
        // CLI projection publishes the buffered report when the native task settles.
        const handback = { type: 'user', uuid: 'handback',
            origin: { kind: 'task-notification', taskId: 'task', toolUseId: 'tool', status: 'completed' },
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool',
                content: [{ type: 'text', text: 'Verdict: fixed.' }], is_error: false }] } };
        const backgroundLaunch = { type: 'assistant', uuid: 'launch', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Agent',
            input: { description: 'Diagnose issue', prompt: 'Diagnose it', subagent_type: 'general-purpose', run_in_background: true } }] } };
        const folded = fold([backgroundLaunch, ack, handback]);
        const tool = folded.tool('tool');
        expect(tool?.state).toBe('completed');
        expect(folded.messages.some(message => message.kind === 'user-text' || message.kind === 'agent-text')).toBe(false);
        if (!tool) throw new Error('Expected settled native tool');
        const { SubAgentView } = await import('@/components/tools/renderers/workflow/SubAgentView');
        const screen = await renderScreen(React.createElement(SubAgentView, {
            tool: normalizeToolCallForRendering(tool), metadata: null, messages: [], detailLevel: 'summary' }));
        expect(collectHostText(screen.tree).join(' ')).toContain('Verdict: fixed.');
        const pending = fold([backgroundLaunch, ack]).tool('tool');
        if (!pending) throw new Error('Expected launched native tool');
        const pendingScreen = await renderScreen(React.createElement(SubAgentView, {
            tool: normalizeToolCallForRendering(pending), metadata: null, messages: [], detailLevel: 'summary' }));
        expect(collectHostText(pendingScreen.tree).join(' ')).not.toContain('Async agent launched');
    });

    // cli-v0.2.16 (b8d1c449c46ab4dfa8637db36b66f643d149e66d), sessionScanner.ts:
    // released task-notification rewrite preserved origin.status but always wrote is_error:false.
    it.each(['completed', 'failed', 'stopped'] as const)('preserves released native task status %s', async status => {
        const historicalCompletion = { ...persistedCompletion, origin: { ...persistedCompletion.origin, status } };
        const folded = fold([launch, ack, historicalCompletion, { ...ack, uuid: 'late-ack' }]);
        const tool = folded.tool('tool');
        expect(tool?.state).toBe(status === 'completed' ? 'completed' : 'error');
        expect(isClaudeAsyncAgentLaunchToolResult(tool?.result)).toBe(false);
        expect(JSON.stringify(tool?.result)).toContain('final findings');
        const roster = deriveSubAgentSidechainSubagents({ messages: folded.messages, flavor: 'claude' });
        expect(roster).toHaveLength(1);
        expect(roster[0]?.status).toBe(status === 'completed' ? 'succeeded' : status === 'stopped' ? 'cancelled' : 'failed');
        if (!tool) throw new Error('Expected settled native tool');
        const renderedResult = normalizeToolCallForRendering(tool).result;
        if (status === 'completed') expect(renderedResult).toBe('final findings');
        else expect(renderedResult).toMatchObject({ content: 'final findings' });
        expect(await renderFullTaskResult(tool)).toContain('final findings');
    });

    it('reads previously persisted native metadata completions and replaces the acknowledgement once', () => {
        const tool = fold([launch, ack, persistedCompletion, { ...persistedCompletion, uuid: 'repeat' }, { ...ack, uuid: 'replayed-ack' }]).tool('tool');
        expect(tool?.state).toBe('completed');
        expect(isClaudeAsyncAgentLaunchToolResult(tool?.result)).toBe(false);
        expect(JSON.stringify(tool?.result)).toContain('final findings');
        expect(tool?.completedAt).toBe(3);
    });

    it.each([
        { ...persistedCompletion, origin: undefined },
        { ...persistedCompletion, origin: { kind: 'task-notification', toolUseId: 'another-tool' } },
        { ...persistedCompletion, message: { content: [{ type: 'text', text: 'metadata' }] } },
    ])('keeps unrelated metadata inert', row => {
        expect(isClaudeAsyncAgentLaunchToolResult(fold([launch, ack, row]).tool('tool')?.result)).toBe(true);
    });

    // The CLI regression emits these files only for the explicitly requested composed check.
    it.runIf(Boolean(process.env.HAPPIER_TASK_PROJECTION_TEST_OUTPUT)).each(['completed', 'failed', 'stopped'] as const)(
        'reduces real persisted scanner output for %s', async status => {
            const rows: unknown = JSON.parse(await readFile(`${process.env.HAPPIER_TASK_PROJECTION_TEST_OUTPUT}.${status}.json`, 'utf8'));
            if (!Array.isArray(rows)) throw new Error('Expected scanner transcript rows');
            const folded = fold(rows);
            const roster = deriveSubAgentSidechainSubagents({ messages: folded.messages, flavor: 'claude' });
            for (const id of ['native-tool', 'early-tool']) {
                expect(folded.tool(id)?.state).toBe(status === 'completed' ? 'completed' : 'error');
                expect(isClaudeAsyncAgentLaunchToolResult(folded.tool(id)?.result)).toBe(false);
                expect(JSON.stringify(folded.tool(id)?.result)).toContain(`native ${status}`);
                expect(roster.find(subagent => subagent.transcript.toolId === id)?.status)
                    .toBe(status === 'completed' ? 'succeeded' : status === 'stopped' ? 'cancelled' : 'failed');
                const task = folded.tool(id);
                if (!task) throw new Error('Expected scanner task result');
                expect(await renderFullTaskResult(task)).toContain(`native ${status}`);
            }
        },
    );
});
