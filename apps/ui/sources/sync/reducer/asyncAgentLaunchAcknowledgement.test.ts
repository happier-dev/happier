import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../typesRaw';
import { createReducer, reducer } from './reducer';

/**
 * An asynchronously launched subagent's launch acknowledgement is a provisional completion.
 *
 * OBSERVED (live session d85429b7, 2026-08-17): the `Agent` tool result returns ~3ms after the
 * launch carrying `{ isAsync: true, status: 'async_launched', agentId, outputFile }`; the agent then
 * runs for hours and its real outcome arrives as a `<task-notification>`, which the CLI's session
 * scanner rewrites into a second `tool_result` for the SAME tool-use id. The reducer refuses any
 * result for a tool that is no longer `running`, so that second result was dropped and the card
 * stayed frozen on "Async agent launched successfully" forever.
 *
 * This is the same shape as the three placeholder completions already excepted here (approved
 * permission, unavailable, legacy interruption): a completion that was never the tool's answer.
 */
const AGENT_TOOL_USE_ID = 'toolu_01HuJR8jRr2sKnGNb1T4ReD4';

function agentToolCall(): NormalizedMessage {
    return {
        id: 'msg-agent-tool-call',
        localId: null,
        createdAt: 1_000,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id: AGENT_TOOL_USE_ID,
            name: 'Agent',
            input: { description: 'Fix fork identity and UI gaps', subagent_type: 'general-purpose' },
            description: null,
            uuid: 'uuid-agent-tool-call',
            parentUUID: null,
        }],
    };
}

function toolResult(params: Readonly<{ id: string; createdAt: number; content: unknown }>): NormalizedMessage {
    return {
        id: params.id,
        localId: null,
        createdAt: params.createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-result',
            tool_use_id: AGENT_TOOL_USE_ID,
            content: params.content,
            is_error: false,
            uuid: `uuid-${params.id}`,
            parentUUID: null,
        }],
    };
}

// The ordinary Claude transcript envelope: `sync/typesRaw/normalize.ts` JSON-encodes the raw
// `toolUseResult` object, so the acknowledgement reaches the reducer as a string.
const ASYNC_LAUNCH_ACKNOWLEDGEMENT = JSON.stringify({
    isAsync: true,
    status: 'async_launched',
    agentId: 'aec7336148831a599',
    description: 'Fix fork identity and UI gaps',
    outputFile: '/tmp/tasks/aec7336148831a599.output',
});

function readAgentTool(state: ReturnType<typeof createReducer>) {
    const messageId = state.toolIdToMessageId.get(AGENT_TOOL_USE_ID);
    return messageId ? state.messages.get(messageId)?.tool ?? null : null;
}

describe('transcript reducer — async agent launch acknowledgement', () => {
    it('lets the agent\'s real result supersede the launch acknowledgement', () => {
        const state = createReducer();

        reducer(state, [agentToolCall()]);
        reducer(state, [toolResult({
            id: 'msg-async-launch',
            createdAt: 1_003,
            content: ASYNC_LAUNCH_ACKNOWLEDGEMENT,
        })]);
        expect(readAgentTool(state)?.state).toBe('completed');

        const update = reducer(state, [toolResult({
            id: 'msg-task-notification',
            createdAt: 5_000_000,
            content: 'All six findings closed at one owner each.',
        })]);

        expect(readAgentTool(state)?.result).toBe('All six findings closed at one owner each.');
        expect(readAgentTool(state)?.state).toBe('completed');
        expect(readAgentTool(state)?.completedAt).toBe(5_000_000);
        expect(update.messages.some((message) => message.kind === 'tool-call')).toBe(true);
    });

    it('does not let a replayed acknowledgement reopen or re-stamp the same launch', () => {
        // The raw transcript channel is not key-deduplicated, so one acknowledgement row can be
        // observed twice. A second acknowledgement is not new evidence and must not move the clock.
        const state = createReducer();

        reducer(state, [agentToolCall()]);
        reducer(state, [toolResult({
            id: 'msg-async-launch',
            createdAt: 1_003,
            content: ASYNC_LAUNCH_ACKNOWLEDGEMENT,
        })]);
        reducer(state, [toolResult({
            id: 'msg-async-launch-replay',
            createdAt: 9_999,
            content: ASYNC_LAUNCH_ACKNOWLEDGEMENT,
        })]);

        expect(readAgentTool(state)?.completedAt).toBe(1_003);
        expect(readAgentTool(state)?.result).toBe(ASYNC_LAUNCH_ACKNOWLEDGEMENT);
    });

    it('leaves an ordinary completed tool closed to a later result', () => {
        // The guard this exception narrows still holds for every other tool.
        const state = createReducer();

        reducer(state, [{
            id: 'msg-bash-tool-call',
            localId: null,
            createdAt: 1_000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'toolu_bash',
                name: 'Bash',
                input: { command: 'ls' },
                description: null,
                uuid: 'uuid-bash-tool-call',
                parentUUID: null,
            }],
        }]);
        reducer(state, [{
            id: 'msg-bash-result',
            localId: null,
            createdAt: 1_100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'toolu_bash',
                content: 'first',
                is_error: false,
                uuid: 'uuid-bash-result',
                parentUUID: null,
            }],
        }]);
        reducer(state, [{
            id: 'msg-bash-result-late',
            localId: null,
            createdAt: 2_000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'toolu_bash',
                content: 'second',
                is_error: false,
                uuid: 'uuid-bash-result-late',
                parentUUID: null,
            }],
        }]);

        const messageId = state.toolIdToMessageId.get('toolu_bash');
        expect(messageId ? state.messages.get(messageId)?.tool?.result : null).toBe('first');
    });
});

/**
 * An asynchronously launched subagent dies with the process that launched it.
 *
 * The launch acknowledgement makes the row honest while the session is alive (it says `running`
 * rather than `succeeded`), but it also puts the row OUTSIDE the owner-death sweep, which only ever
 * looked at `running` tool calls. So a session whose process is gone left every plain subagent it
 * launched presenting as work in progress, permanently — the same "panel full of Working agents"
 * failure the workflow path already closes through `ownerProcessEnded` (RULING-14).
 *
 * Evidence-based, never time-based: the trigger is the owning process being observed gone, and a
 * sidechain that spoke after that instant proves the instant is stale rather than final.
 */
function sidechainMessage(params: Readonly<{ id: string; createdAt: number; text: string }>): NormalizedMessage {
    return {
        id: params.id,
        localId: null,
        createdAt: params.createdAt,
        role: 'agent',
        isSidechain: true,
        sidechainId: AGENT_TOOL_USE_ID,
        content: [{
            type: 'text',
            text: params.text,
            uuid: `uuid-${params.id}`,
            parentUUID: null,
        }],
    } as NormalizedMessage;
}

function launchedAgentState() {
    const state = createReducer();
    reducer(state, [agentToolCall()]);
    reducer(state, [toolResult({
        id: 'msg-async-launch',
        createdAt: 1_003,
        content: ASYNC_LAUNCH_ACKNOWLEDGEMENT,
    })]);
    return state;
}

describe('transcript reducer — an async-launched subagent outlives nothing', () => {
    it('closes an async-launched subagent once the session process that hosted it is gone', () => {
        const state = launchedAgentState();
        expect(readAgentTool(state)?.state).toBe('completed');

        reducer(state, [], null, { ownerProcessGoneSinceMs: 4_000 });

        expect(readAgentTool(state)?.state).toBe('unavailable');
        expect(readAgentTool(state)?.completedAt).toBe(4_000);
    });

    it('keeps an async-launched subagent open when its sidechain spoke after the process was last seen', () => {
        // The resumable case: the instant we last saw the process is stale, not final.
        const state = launchedAgentState();
        reducer(state, [sidechainMessage({ id: 'msg-sc-late', createdAt: 5_000, text: 'still working' })]);

        reducer(state, [], null, { ownerProcessGoneSinceMs: 4_000 });

        expect(readAgentTool(state)?.state).toBe('completed');
        expect(readAgentTool(state)?.completedAt).toBe(1_003);
    });

    it('leaves an async-launched subagent open at an ordinary turn boundary', () => {
        // A turn ending is not the process ending, and an async agent legitimately outlives the turn
        // that launched it. Only owner death closes it.
        const state = launchedAgentState();

        reducer(state, [{
            id: 'ready-1',
            localId: null,
            createdAt: 4_000,
            role: 'event',
            isSidechain: false,
            content: { type: 'ready' },
        } as NormalizedMessage]);

        expect(readAgentTool(state)?.state).toBe('completed');
    });

    it('does not close an ordinary completed tool when the process is gone', () => {
        // The exception is bounded to a subagent launch acknowledgement: a real result is a real
        // result, and owner death must not overwrite it.
        const state = createReducer();
        reducer(state, [{
            id: 'msg-bash-tool-call',
            localId: null,
            createdAt: 1_000,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-call',
                id: 'toolu_bash_owner',
                name: 'Bash',
                input: { command: 'ls' },
                description: null,
                uuid: 'uuid-bash-owner',
                parentUUID: null,
            }],
        } as NormalizedMessage]);
        reducer(state, [{
            id: 'msg-bash-result',
            localId: null,
            createdAt: 1_100,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: 'toolu_bash_owner',
                content: 'done',
                is_error: false,
                uuid: 'uuid-bash-owner-result',
                parentUUID: null,
            }],
        } as NormalizedMessage]);

        reducer(state, [], null, { ownerProcessGoneSinceMs: 4_000 });

        const messageId = state.toolIdToMessageId.get('toolu_bash_owner');
        const tool = messageId ? state.messages.get(messageId)?.tool : null;
        expect(tool?.state).toBe('completed');
        expect(tool?.result).toBe('done');
    });
});
