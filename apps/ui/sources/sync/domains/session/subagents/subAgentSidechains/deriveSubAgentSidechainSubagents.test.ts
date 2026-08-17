import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { deriveSubAgentSidechainSubagents } from './deriveSubAgentSidechainSubagents';

const REQUESTED_AT = 1_700_000_000_000;

function createSubAgentMessage(params: Readonly<{
    state: 'running' | 'completed' | 'error';
    toolId?: string;
    createdAt?: number;
    toolStartedAt?: number | null;
    toolCompletedAt?: number | null;
    input?: Record<string, unknown>;
}>): ToolCallMessage {
    const createdAt = params.createdAt ?? REQUESTED_AT;
    return {
        kind: 'tool-call',
        id: 'message_subagent',
        localId: null,
        createdAt,
        tool: {
            id: params.toolId ?? 'tool_subagent',
            name: 'Task',
            state: params.state,
            input: params.input ?? { name: 'Reviewer' },
            createdAt,
            startedAt: params.toolStartedAt !== undefined ? params.toolStartedAt : createdAt,
            completedAt: params.toolCompletedAt !== undefined
                ? params.toolCompletedAt
                : (params.state === 'running' ? null : createdAt + 1_000),
            description: null,
        },
        children: [],
    } as ToolCallMessage;
}

function deriveSingle(messages: readonly Message[]) {
    const subagents = deriveSubAgentSidechainSubagents({ messages, flavor: 'claude' });
    expect(subagents, 'fixture must derive exactly one sidechain subagent').toHaveLength(1);
    return subagents[0]!;
}

describe('deriveSubAgentSidechainSubagents — elapsed time is never fabricated (D-8)', () => {
    it('records the genuine finish instant once the sidechain tool completes', () => {
        const subagent = deriveSingle([
            createSubAgentMessage({
                state: 'completed',
                createdAt: REQUESTED_AT,
                toolStartedAt: REQUESTED_AT + 500,
                toolCompletedAt: REQUESTED_AT + 42_000,
            }),
        ]);

        expect(subagent.status).toBe('succeeded');
        expect(subagent.timestamps.startedAtMs).toBe(REQUESTED_AT + 500);
        // Without this the row keeps a LIVE clock on a finished agent: the time slot only stops
        // counting when it is given a finish instant.
        expect(subagent.timestamps.finishedAtMs).toBe(REQUESTED_AT + 42_000);
    });

    it('leaves a running sidechain subagent with no finish instant', () => {
        const subagent = deriveSingle([
            createSubAgentMessage({
                state: 'running',
                createdAt: REQUESTED_AT,
                toolStartedAt: REQUESTED_AT,
                toolCompletedAt: null,
            }),
        ]);

        expect(subagent.status).toBe('running');
        expect(subagent.timestamps.startedAtMs).toBe(REQUESTED_AT);
        expect(subagent.timestamps.finishedAtMs).toBeUndefined();
    });

    it('claims no finish instant for a terminal tool that never recorded one', () => {
        const subagent = deriveSingle([
            createSubAgentMessage({
                state: 'error',
                createdAt: REQUESTED_AT,
                toolStartedAt: REQUESTED_AT,
                toolCompletedAt: null,
            }),
        ]);

        expect(subagent.status).toBe('failed');
        expect(subagent.timestamps.finishedAtMs).toBeUndefined();
    });

    it('falls back to the request instant while a permission prompt holds the call', () => {
        const subagent = deriveSingle([
            createSubAgentMessage({
                state: 'running',
                createdAt: REQUESTED_AT,
                toolStartedAt: null,
                toolCompletedAt: null,
            }),
        ]);

        expect(subagent.timestamps.startedAtMs).toBe(REQUESTED_AT);
    });
});

describe('deriveSubAgentSidechainSubagents — the row title reads the names producers actually ship', () => {
    function titleFor(input: Record<string, unknown>): string {
        return deriveSingle([createSubAgentMessage({ state: 'running', input })]).display.title;
    }

    // Codex spawns agents with a human-assigned nickname (rollout `new_agent_nickname`, e.g.
    // "Lovelace") that buildCodexSyntheticSubagentToolCall already puts on the wire. It is the one
    // field that tells sibling agents apart, so it outranks the categorical role and the prompt.
    it('prefers the Codex-assigned nickname over the role and the spawn prompt', () => {
        expect(titleFor({
            threadId: 'thread_lovelace',
            nickname: 'Lovelace',
            role: 'reviewer',
            prompt: 'Review the diff and report every correctness defect you find.',
        })).toBe('Lovelace');
    });

    it('falls back to the Codex role when the agent was spawned without a nickname', () => {
        expect(titleFor({
            threadId: 'thread_unnamed',
            role: 'reviewer',
            prompt: 'Review the diff and report every correctness defect you find.',
        })).toBe('reviewer');
    });

    // The task description says what this run is doing; subagent_type only says which category of
    // agent it is. This locks that ordering, and matches the CLI's own chain.
    it('prefers the task description over the categorical subagent type', () => {
        expect(titleFor({
            description: 'Search TypeScript 5.6 features',
            subagent_type: 'general-purpose',
            prompt: 'Search the web for information about TypeScript 5.6 new features.',
        })).toBe('Search TypeScript 5.6 features');
    });

    it('uses subagent_type rather than the prompt when no description was shipped', () => {
        expect(titleFor({
            subagent_type: 'general-purpose',
            prompt: 'Search the web for information about TypeScript 5.6 new features.',
        })).toBe('general-purpose');
    });

    it('bounds the prompt fallback so a whole prompt can never become the row title', () => {
        const title = titleFor({ prompt: 'a'.repeat(900) });

        expect(title).toHaveLength(512);
        expect(title.endsWith('…')).toBe(true);
    });
});

/**
 * An asynchronously launched subagent is running, not finished.
 *
 * OBSERVED (live session d85429b7, 2026-08-17): Claude Code launches the generic subagent tool
 * asynchronously. Its tool result returns ~3ms after the launch carrying
 * `{ isAsync: true, status: 'async_launched', agentId, outputFile }` while the agent then runs for
 * hours; the real outcome arrives much later as a `<task-notification>`. The transcript normalizer
 * JSON-encodes the raw `toolUseResult` into `tool.result`, so that acknowledgement is exactly what
 * this derivation sees — and reading the launching call's completion as the agent's completion drew
 * every live subagent as `succeeded` seconds after it started.
 */
describe('deriveSubAgentSidechainSubagents — an async launch acknowledgement is not a result', () => {
    function createAsyncLaunchedSubAgentMessage(result: unknown): ToolCallMessage {
        return {
            kind: 'tool-call',
            id: 'message_async_subagent',
            localId: null,
            createdAt: REQUESTED_AT,
            tool: {
                id: 'tool_async_subagent',
                name: 'Agent',
                state: 'completed',
                input: { description: 'Fix fork identity and UI gaps', subagent_type: 'general-purpose' },
                createdAt: REQUESTED_AT,
                startedAt: REQUESTED_AT,
                completedAt: REQUESTED_AT + 3,
                description: null,
                result,
            },
            children: [],
        } as ToolCallMessage;
    }

    const ASYNC_LAUNCH_ACKNOWLEDGEMENT = {
        isAsync: true,
        status: 'async_launched',
        agentId: 'aec7336148831a599',
        description: 'Fix fork identity and UI gaps',
        outputFile: '/tmp/tasks/aec7336148831a599.output',
    };

    it('reports a JSON-encoded async launch acknowledgement as running', () => {
        // The ordinary Claude transcript envelope: `tool.result` is the JSON-encoded `toolUseResult`.
        const subagent = deriveSingle([
            createAsyncLaunchedSubAgentMessage(JSON.stringify(ASYNC_LAUNCH_ACKNOWLEDGEMENT)),
        ]);

        expect(subagent.status).toBe('running');
        // Nothing finished, so no finish instant may be claimed — the row must not run an elapsed
        // clock backwards from a launch acknowledgement.
        expect(subagent.timestamps.finishedAtMs).toBeUndefined();
    });

    it('reports an object-shaped async launch acknowledgement as running', () => {
        const subagent = deriveSingle([
            createAsyncLaunchedSubAgentMessage(ASYNC_LAUNCH_ACKNOWLEDGEMENT),
        ]);

        expect(subagent.status).toBe('running');
    });

    it('reports the agent as succeeded once a real result supersedes the acknowledgement', () => {
        const subagent = deriveSingle([
            createAsyncLaunchedSubAgentMessage('All six findings closed at one owner each.'),
        ]);

        expect(subagent.status).toBe('succeeded');
        expect(subagent.timestamps.finishedAtMs).toBe(REQUESTED_AT + 3);
    });

    it('still reports a failed launch as failed', () => {
        const message = createAsyncLaunchedSubAgentMessage(JSON.stringify(ASYNC_LAUNCH_ACKNOWLEDGEMENT));
        message.tool.state = 'error';

        expect(deriveSingle([message]).status).toBe('failed');
    });

    it('reports a subagent whose session process died as cancelled, not ambiguous', () => {
        // RULING-14 (terminal state on process death) already answers this for a workflow agent —
        // `terminalizeRunAgents` resolves it to `cancelled`, never `failed`: an agent that produced
        // no result while its host went away was cut off, it did not fail. A plain subagent is the
        // same agent seen without a run around it, so it must read the same. Answering `unknown`
        // here made the roster say two different things about one event depending only on whether a
        // second agent happened to exist (below two, no headline is published and this local answer
        // is the only one), and `unknown` is reserved for a genuinely ambiguous source rather than
        // used as the fallback for a mapped one.
        const message = createAsyncLaunchedSubAgentMessage(JSON.stringify(ASYNC_LAUNCH_ACKNOWLEDGEMENT));
        message.tool.state = 'unavailable';

        expect(deriveSingle([message]).status).toBe('cancelled');
    });
});
