import { describe, expect, it } from 'vitest';

import {
    isClaudeAsyncAgentLaunchToolResult,
    isTerminalClaudeAgentSdkProviderTaskStatus,
    normalizeClaudeActivityStatusSignal,
    normalizeClaudeAgentSdkProviderTaskId,
    normalizeClaudeAgentSdkProviderTaskStatus,
    normalizeClaudeTaskToolRecordsToWorkStateItems,
    normalizeClaudeTaskToolUseToWorkStateItem,
    normalizeClaudeTaskEventToWorkStateItem,
    normalizeClaudeTodoWriteTodosToWorkStateItems,
    readClaudeAgentSdkProviderTaskStatus,
} from './sessionTasks.js';

describe('normalizeClaudeActivityStatusSignal (canonical Claude status classifier)', () => {
    it('maps the full Claude activity vocabulary to neutral 7-value status', () => {
        expect(normalizeClaudeActivityStatusSignal('pending')).toBe('pending');
        expect(normalizeClaudeActivityStatusSignal('running')).toBe('active');
        expect(normalizeClaudeActivityStatusSignal('in_progress')).toBe('active');
        expect(normalizeClaudeActivityStatusSignal('active')).toBe('active');
        expect(normalizeClaudeActivityStatusSignal('progress')).toBe('active');
        expect(normalizeClaudeActivityStatusSignal('completed')).toBe('complete');
        expect(normalizeClaudeActivityStatusSignal('complete')).toBe('complete');
        expect(normalizeClaudeActivityStatusSignal('done')).toBe('complete');
        expect(normalizeClaudeActivityStatusSignal('succeeded')).toBe('complete');
        expect(normalizeClaudeActivityStatusSignal('success')).toBe('complete');
        expect(normalizeClaudeActivityStatusSignal('failed')).toBe('failed');
        expect(normalizeClaudeActivityStatusSignal('error')).toBe('failed');
        expect(normalizeClaudeActivityStatusSignal('errored')).toBe('failed');
        expect(normalizeClaudeActivityStatusSignal('blocked')).toBe('blocked');
        expect(normalizeClaudeActivityStatusSignal('cancelled')).toBe('cancelled');
        expect(normalizeClaudeActivityStatusSignal('canceled')).toBe('cancelled');
        expect(normalizeClaudeActivityStatusSignal('stopped')).toBe('cancelled');
        expect(normalizeClaudeActivityStatusSignal('killed')).toBe('cancelled');
        expect(normalizeClaudeActivityStatusSignal('aborted')).toBe('cancelled');
        expect(normalizeClaudeActivityStatusSignal('interrupted')).toBe('cancelled');
    });

    /**
     * `start` is the state Claude's live Dynamic Workflow stream gives an agent the moment it
     * launches — OBSERVED on claude 2.1.231, where every `workflow_agent` entry arrives as
     * `state: "start"` and only later becomes `progress`/`done`. Falling through to `unknown` left
     * every freshly launched workflow agent classified as neither running nor finished, which for a
     * short agent is its entire visible life.
     */
    it('treats a launching workflow agent (state "start") as active', () => {
        expect(normalizeClaudeActivityStatusSignal('start')).toBe('active');
        expect(normalizeClaudeActivityStatusSignal('START')).toBe('active');
        expect(normalizeClaudeActivityStatusSignal(' start ')).toBe('active');
    });

    it('treats task_started / task_progress event types as active when status is absent', () => {
        expect(normalizeClaudeActivityStatusSignal(undefined, 'task_started')).toBe('active');
        expect(normalizeClaudeActivityStatusSignal(null, 'task_progress')).toBe('active');
    });

    it('maps missing/unknown signals to unknown', () => {
        expect(normalizeClaudeActivityStatusSignal(undefined)).toBe('unknown');
        expect(normalizeClaudeActivityStatusSignal(null)).toBe('unknown');
        expect(normalizeClaudeActivityStatusSignal('weird')).toBe('unknown');
        expect(normalizeClaudeActivityStatusSignal(42)).toBe('unknown');
    });

    it('keeps the work-state projection (failed -> blocked) intact for task lifecycle events', () => {
        // The exported classifier is the single source of truth that the work-state task mapper
        // delegates to; `failed` must still project to work-state `blocked` (no `failed` in work-state).
        const failed = normalizeClaudeTaskEventToWorkStateItem({
            backendId: 'claude',
            updatedAt: 1,
            event: { type: 'task_updated', task_id: 't1', description: 'x', status: 'failed' },
        });
        expect(failed?.status).toBe('blocked');
        const completed = normalizeClaudeTaskEventToWorkStateItem({
            backendId: 'claude',
            updatedAt: 1,
            event: { type: 'task_updated', task_id: 't1', description: 'x', status: 'completed' },
        });
        expect(completed?.status).toBe('complete');
        const started = normalizeClaudeTaskEventToWorkStateItem({
            backendId: 'claude',
            updatedAt: 1,
            event: { type: 'task_started', task_id: 't1', description: 'x' },
        });
        expect(started?.status).toBe('active');
    });
});

describe('Claude Agent SDK provider task status normalization', () => {
    it('normalizes SDK task ids and statuses without losing SDK terminal vocabulary', () => {
        expect(normalizeClaudeAgentSdkProviderTaskId(' task-1 ')).toBe('task-1');
        expect(normalizeClaudeAgentSdkProviderTaskId('   ')).toBeNull();
        expect(normalizeClaudeAgentSdkProviderTaskId(42)).toBeNull();

        expect(normalizeClaudeAgentSdkProviderTaskStatus(' Succeeded ')).toBe('succeeded');
        expect(readClaudeAgentSdkProviderTaskStatus({ patch: { status: 'Running' } })).toBe('running');
        expect(readClaudeAgentSdkProviderTaskStatus({ status: ' Errored ' })).toBe('errored');
    });

    it('treats all known SDK terminal task statuses as terminal', () => {
        for (const status of [
            'completed',
            'complete',
            'done',
            'succeeded',
            'success',
            'stopped',
            'failed',
            'error',
            'errored',
            'killed',
            'aborted',
            'interrupted',
            'cancelled',
            'canceled',
        ]) {
            expect(isTerminalClaudeAgentSdkProviderTaskStatus(status)).toBe(true);
        }

        expect(isTerminalClaudeAgentSdkProviderTaskStatus('running')).toBe(false);
        expect(isTerminalClaudeAgentSdkProviderTaskStatus('async_launched')).toBe(false);
        expect(isTerminalClaudeAgentSdkProviderTaskStatus('unknown')).toBe(false);
    });

    it('derives terminality from the canonical neutral status classifier', () => {
        for (const status of [
            'completed', 'complete', 'done', 'succeeded', 'success',
            'failed', 'error', 'errored',
            'stopped', 'killed', 'aborted', 'interrupted', 'cancelled', 'canceled',
        ]) {
            const signal = normalizeClaudeActivityStatusSignal(status);
            expect(['complete', 'failed', 'cancelled']).toContain(signal);
            expect(isTerminalClaudeAgentSdkProviderTaskStatus(status)).toBe(true);
        }

        for (const status of ['pending', 'running', 'active', 'in_progress', 'progress', 'blocked', 'unknown']) {
            expect(isTerminalClaudeAgentSdkProviderTaskStatus(status)).toBe(false);
        }
    });
});

describe('Claude task and todo wire schemas', () => {
    it('normalizes task lifecycle statuses without leaking provider status values', () => {
        const item = normalizeClaudeTaskEventToWorkStateItem({
            backendId: 'claude',
            updatedAt: 456,
            event: {
                type: 'task_updated',
                task_id: 'task-1',
                description: 'Run migration',
                status: 'failed',
            },
        });

        expect(item).toMatchObject({
            id: 'task:task-1',
            kind: 'task',
            origin: 'vendor',
            status: 'blocked',
            title: 'Run migration',
            backendId: 'claude',
            vendorRef: 'task-1',
            updatedAt: 456,
        });
        expect((item?.status as string)).not.toBe('failed');
    });

    it('normalizes TodoWrite entries into generic todo items', () => {
        const items = normalizeClaudeTodoWriteTodosToWorkStateItems({
            backendId: 'claude',
            updatedAt: 789,
            todos: [
                { content: 'Patch schema', status: 'in_progress', activeForm: 'Patching schema' },
                { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
            ],
        });

        expect(items.map((item) => item.status)).toEqual(['active', 'pending']);
        expect(items[0]?.id).toMatch(/^todo:derived:/);
    });

    it('normalizes TaskCreate tool uses into provisional task items', () => {
        const item = normalizeClaudeTaskToolUseToWorkStateItem({
            backendId: 'claude',
            updatedAt: 101,
            toolName: 'TaskCreate',
            toolUseId: 'toolu_create_1',
            input: {
                subject: 'Patch work-state projection',
                description: 'Update Claude task tracking',
                activeForm: 'Patching work-state projection',
            },
        });

        expect(item).toMatchObject({
            id: 'task:derived:claude.task:tool_use%3Atoolu_create_1',
            kind: 'task',
            origin: 'vendor',
            status: 'pending',
            title: 'Patch work-state projection',
            summary: 'Patching work-state projection',
            vendorRef: 'tool_use:toolu_create_1',
            updatedAt: 101,
        });
    });

    it('normalizes TaskUpdate tool uses by Claude task id', () => {
        const item = normalizeClaudeTaskToolUseToWorkStateItem({
            backendId: 'claude',
            updatedAt: 102,
            toolName: 'TaskUpdate',
            input: {
                taskId: 'task_123',
                subject: 'Run regression tests',
                status: 'in_progress',
            },
        });

        expect(item).toMatchObject({
            id: 'task:derived:claude.task:task_123',
            kind: 'task',
            origin: 'vendor',
            status: 'active',
            title: 'Run regression tests',
            vendorRef: 'task_123',
            updatedAt: 102,
        });
    });

    it('omits deleted TaskUpdate items', () => {
        const item = normalizeClaudeTaskToolUseToWorkStateItem({
            backendId: 'claude',
            updatedAt: 103,
            toolName: 'TaskUpdate',
            input: {
                taskId: 'task_123',
                status: 'deleted',
            },
        });

        expect(item).toBeNull();
    });

    it('normalizes TaskList result records into task items', () => {
        const items = normalizeClaudeTaskToolRecordsToWorkStateItems({
            backendId: 'claude',
            updatedAt: 104,
            tasks: [
                { id: 'task_a', subject: 'Check docs', status: 'completed' },
                { taskId: 'task_b', subject: 'Fix parser', status: 'pending', activeForm: 'Fixing parser' },
                { id: 'task_deleted', subject: 'Old task', status: 'deleted' },
            ],
        });

        expect(items.map((item) => [item.vendorRef, item.status, item.title, item.summary])).toEqual([
            ['task_a', 'complete', 'Check docs', undefined],
            ['task_b', 'pending', 'Fix parser', 'Fixing parser'],
        ]);
    });
});

/**
 * OBSERVED (live Claude session d85429b7, 2026-08-17): every generic subagent launch returns
 * `{ isAsync: true, status: 'async_launched', agentId, outputFile }` within milliseconds while the
 * agent runs on. Two packages read that same fact through different envelopes, so the unwrapping is
 * part of the contract, not an implementation detail of either consumer.
 */
describe('isClaudeAsyncAgentLaunchToolResult', () => {
    const ACKNOWLEDGEMENT = {
        isAsync: true,
        status: 'async_launched',
        agentId: 'aec7336148831a599',
        outputFile: '/tmp/tasks/aec7336148831a599.output',
    };

    it('recognises the acknowledgement as an object', () => {
        expect(isClaudeAsyncAgentLaunchToolResult(ACKNOWLEDGEMENT)).toBe(true);
    });

    it('recognises it through the transcript envelope, which JSON-encodes the tool result', () => {
        expect(isClaudeAsyncAgentLaunchToolResult(JSON.stringify(ACKNOWLEDGEMENT))).toBe(true);
    });

    it('recognises it through the SDK log-converter envelope, which nests the object', () => {
        expect(isClaudeAsyncAgentLaunchToolResult({ tool_use_result: ACKNOWLEDGEMENT })).toBe(true);
        expect(isClaudeAsyncAgentLaunchToolResult({ toolUseResult: ACKNOWLEDGEMENT })).toBe(true);
        expect(isClaudeAsyncAgentLaunchToolResult(JSON.stringify({ toolUseResult: ACKNOWLEDGEMENT }))).toBe(true);
    });

    it('recognises a remote launch, which is the same claim about a different runner', () => {
        expect(isClaudeAsyncAgentLaunchToolResult({ status: 'remote_launched', agentId: 'a1' })).toBe(true);
    });

    it('does not claim a launch for a real result, a terminal status, or unparseable prose', () => {
        expect(isClaudeAsyncAgentLaunchToolResult('All six findings closed at one owner each.')).toBe(false);
        expect(isClaudeAsyncAgentLaunchToolResult({ status: 'completed', agentId: 'a1' })).toBe(false);
        expect(isClaudeAsyncAgentLaunchToolResult({ stdout: 'ok', exit_code: 0 })).toBe(false);
        // A subagent may well REPORT the word in its own output; only the typed status counts.
        expect(isClaudeAsyncAgentLaunchToolResult('status: async_launched')).toBe(false);
    });

    it('answers false rather than throwing for anything unrecognised', () => {
        expect(isClaudeAsyncAgentLaunchToolResult(undefined)).toBe(false);
        expect(isClaudeAsyncAgentLaunchToolResult(null)).toBe(false);
        expect(isClaudeAsyncAgentLaunchToolResult(42)).toBe(false);
        expect(isClaudeAsyncAgentLaunchToolResult([ACKNOWLEDGEMENT])).toBe(false);
        expect(isClaudeAsyncAgentLaunchToolResult('{ not json')).toBe(false);
    });
});
